package socket_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/Cozzytree/gosocket/pkg/socket"
)

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const msgTimeout = 2 * time.Second

// testServer wraps a socket.Server and an httptest.Server so each test gets
// a completely isolated server with its own hub.
type testServer struct {
	srv  *socket.Server
	http *httptest.Server
}

func newTestServer(t *testing.T) *testServer {
	t.Helper()
	s := socket.NewServer(nil)
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", s.ServeWS)
	hs := httptest.NewServer(mux)
	t.Cleanup(hs.Close)
	return &testServer{srv: s, http: hs}
}

// wsURL returns the ws:// URL for the test server endpoint.
func (ts *testServer) wsURL() string {
	return "ws" + strings.TrimPrefix(ts.http.URL, "http") + "/ws"
}

// ---------------------------------------------------------------------------
// wsConn – thin wrapper around a gorilla client connection.
// ---------------------------------------------------------------------------

type wsConn struct {
	t    *testing.T
	conn *websocket.Conn
}

func dial(t *testing.T, ts *testServer) *wsConn {
	t.Helper()
	c, _, err := websocket.DefaultDialer.Dial(ts.wsURL(), nil)
	require.NoError(t, err, "dial failed")
	t.Cleanup(func() { _ = c.Close() })
	return &wsConn{t: t, conn: c}
}

// sendEvent sends ["eventName", args...] to the server (no ack).
func (c *wsConn) sendEvent(event string, args ...interface{}) {
	c.t.Helper()
	payload := append([]interface{}{event}, args...)
	b, err := json.Marshal(payload)
	require.NoError(c.t, err)
	require.NoError(c.t, c.conn.WriteMessage(websocket.TextMessage, b))
}

// sendEventWithAck sends [ackID, "eventName", args...] to the server.
func (c *wsConn) sendEventWithAck(ackID int, event string, args ...interface{}) {
	c.t.Helper()
	payload := append([]interface{}{ackID, event}, args...)
	b, err := json.Marshal(payload)
	require.NoError(c.t, err)
	require.NoError(c.t, c.conn.WriteMessage(websocket.TextMessage, b))
}

// readMsg reads the next text frame and returns it as a parsed JSON array.
// Fails the test if nothing arrives within msgTimeout.
func (c *wsConn) readMsg() []interface{} {
	c.t.Helper()
	require.NoError(c.t, c.conn.SetReadDeadline(time.Now().Add(msgTimeout)))
	_, b, err := c.conn.ReadMessage()
	require.NoError(c.t, err, "readMsg timed out or errored")
	var arr []interface{}
	require.NoError(c.t, json.Unmarshal(b, &arr))
	return arr
}

// readMsgEvent reads the next message and asserts its event name, returning args.
func (c *wsConn) readMsgEvent(wantEvent string) []interface{} {
	c.t.Helper()
	arr := c.readMsg()
	require.NotEmpty(c.t, arr, "empty message array")
	assert.Equal(c.t, wantEvent, arr[0], "unexpected event name")
	return arr[1:]
}

// readMsgs reads exactly n frames and returns them all. Useful when the server
// sends multiple frames whose relative order is not guaranteed.
func (c *wsConn) readMsgs(n int) [][]interface{} {
	c.t.Helper()
	out := make([][]interface{}, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, c.readMsg())
	}
	return out
}

// findEvent returns the args of the first message with the given event name, or
// fails the test if none is found.
func findEvent(t *testing.T, msgs [][]interface{}, event string) []interface{} {
	t.Helper()
	for _, m := range msgs {
		if len(m) > 0 && m[0] == event {
			return m[1:]
		}
	}
	t.Fatalf("event %q not found in %d messages", event, len(msgs))
	return nil
}

// expectNoMsg asserts no message arrives within a short window.
func (c *wsConn) expectNoMsg(window time.Duration) {
	c.t.Helper()
	_ = c.conn.SetReadDeadline(time.Now().Add(window))
	_, _, err := c.conn.ReadMessage()
	require.Error(c.t, err, "expected no message but got one")
	// Reset deadline.
	_ = c.conn.SetReadDeadline(time.Time{})
}

// close sends a clean close frame.
func (c *wsConn) close() {
	c.t.Helper()
	_ = c.conn.WriteMessage(websocket.CloseMessage,
		websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
}

// waitChan returns a channel that closes after the WaitGroup reaches zero.
func waitChan(wg *sync.WaitGroup) <-chan struct{} {
	ch := make(chan struct{})
	go func() { wg.Wait(); close(ch) }()
	return ch
}

// ---------------------------------------------------------------------------
// Connection callbacks
// ---------------------------------------------------------------------------

func TestOnConnect_FiresOnClientConnect(t *testing.T) {
	ts := newTestServer(t)

	var wg sync.WaitGroup
	wg.Add(1)
	var gotID string
	ts.srv.OnConnect = func(c *socket.Client, r *http.Request) {
		gotID = c.ID
		wg.Done()
	}

	dial(t, ts)

	select {
	case <-waitChan(&wg):
	case <-time.After(msgTimeout):
		t.Fatal("OnConnect did not fire")
	}

	assert.NotEmpty(t, gotID, "client ID should be set")
	assert.Len(t, gotID, 32, "ID should be 32-char hex")
}

func TestOnConnect_ClientIsAlreadyInHub(t *testing.T) {
	// Client must be registered in the hub before OnConnect fires so that
	// any hub operation inside OnConnect (e.g. broadcasting) works.
	ts := newTestServer(t)

	var wg sync.WaitGroup
	wg.Add(1)
	var isMember bool
	ts.srv.OnConnect = func(c *socket.Client, r *http.Request) {
		_ = c.Join("lobby")
		isMember = ts.srv.Hub().IsMember(c, "lobby")
		wg.Done()
	}

	dial(t, ts)

	select {
	case <-waitChan(&wg):
	case <-time.After(msgTimeout):
		t.Fatal("OnConnect did not fire")
	}

	assert.True(t, isMember, "client should be in hub before OnConnect returns")
}

func TestOnDisconnect_FiresOnClientClose(t *testing.T) {
	ts := newTestServer(t)

	connected := make(chan *socket.Client, 1)
	ts.srv.OnConnect = func(c *socket.Client, _ *http.Request) { connected <- c }

	disconnected := make(chan *socket.Client, 1)
	ts.srv.OnDisconnect = func(c *socket.Client) { disconnected <- c }

	conn := dial(t, ts)
	var serverClient *socket.Client
	select {
	case serverClient = <-connected:
	case <-time.After(msgTimeout):
		t.Fatal("OnConnect did not fire")
	}

	conn.close()

	select {
	case got := <-disconnected:
		assert.Equal(t, serverClient.ID, got.ID)
	case <-time.After(msgTimeout):
		t.Fatal("OnDisconnect did not fire")
	}
}

func TestOnDisconnect_UniqueIDPerClient(t *testing.T) {
	ts := newTestServer(t)
	ids := make(chan string, 3)
	ts.srv.OnConnect = func(c *socket.Client, _ *http.Request) { ids <- c.ID }

	dial(t, ts)
	dial(t, ts)
	dial(t, ts)

	seen := make(map[string]bool)
	for i := 0; i < 3; i++ {
		select {
		case id := <-ids:
			assert.False(t, seen[id], "duplicate client ID: %s", id)
			seen[id] = true
		case <-time.After(msgTimeout):
			t.Fatal("timed out waiting for OnConnect")
		}
	}
}

// ---------------------------------------------------------------------------
// Server → client emit
// ---------------------------------------------------------------------------

func TestServerEmit_ClientReceivesEvent(t *testing.T) {
	ts := newTestServer(t)
	ts.srv.OnConnect = func(c *socket.Client, _ *http.Request) {
		c.Emit("welcome", map[string]string{"msg": "hello"})
	}

	conn := dial(t, ts)
	args := conn.readMsgEvent("welcome")
	require.Len(t, args, 1)

	var payload map[string]string
	b, _ := json.Marshal(args[0])
	require.NoError(t, json.Unmarshal(b, &payload))
	assert.Equal(t, "hello", payload["msg"])
}

func TestServerEmit_MultipleArgs(t *testing.T) {
	ts := newTestServer(t)
	ts.srv.OnConnect = func(c *socket.Client, _ *http.Request) {
		c.Emit("data", 42, "hello", true)
	}

	conn := dial(t, ts)
	args := conn.readMsgEvent("data")
	require.Len(t, args, 3)
	assert.EqualValues(t, 42, args[0])
	assert.Equal(t, "hello", args[1])
	assert.Equal(t, true, args[2])
}

// ---------------------------------------------------------------------------
// OnMessage catch-all
// ---------------------------------------------------------------------------

func TestOnMessage_FiredForEveryIncomingEvent(t *testing.T) {
	ts := newTestServer(t)

	var mu sync.Mutex
	var captured []socket.Packet
	ts.srv.OnMessage = func(_ *socket.Client, msg socket.Packet) {
		mu.Lock()
		captured = append(captured, msg)
		mu.Unlock()
	}

	conn := dial(t, ts)
	conn.sendEvent("foo", "bar")
	conn.sendEvent("baz")
	time.Sleep(100 * time.Millisecond) // let server process both

	mu.Lock()
	defer mu.Unlock()
	require.Len(t, captured, 2)
	assert.Equal(t, "foo", captured[0].Event)
	assert.Equal(t, "baz", captured[1].Event)
}

// ---------------------------------------------------------------------------
// Event handlers (On)
// ---------------------------------------------------------------------------

func TestEventHandler_NoAck_HandlerFires(t *testing.T) {
	ts := newTestServer(t)

	received := make(chan []json.RawMessage, 1)
	ts.srv.On("chat", func(_ *socket.Client, args []json.RawMessage, _ func(...interface{})) {
		received <- args
	})

	conn := dial(t, ts)
	conn.sendEvent("chat", map[string]string{"text": "hello"})

	select {
	case args := <-received:
		require.Len(t, args, 1)
		var payload map[string]string
		require.NoError(t, json.Unmarshal(args[0], &payload))
		assert.Equal(t, "hello", payload["text"])
	case <-time.After(msgTimeout):
		t.Fatal("handler did not fire")
	}
}

func TestEventHandler_WithAck_ClientReceivesAckResponse(t *testing.T) {
	ts := newTestServer(t)

	ts.srv.On("ping", func(_ *socket.Client, _ []json.RawMessage, ack func(...interface{})) {
		ack(map[string]interface{}{"pong": true})
	})

	conn := dial(t, ts)
	conn.sendEventWithAck(7, "ping")

	// Server should respond with ["_ack_", 7, {"pong":true}]
	arr := conn.readMsg()
	require.Len(t, arr, 3)
	assert.Equal(t, "_ack_", arr[0])
	assert.EqualValues(t, 7, arr[1])

	b, _ := json.Marshal(arr[2])
	var result map[string]interface{}
	require.NoError(t, json.Unmarshal(b, &result))
	assert.Equal(t, true, result["pong"])
}

func TestEventHandler_WithAck_MultipleAckArgs(t *testing.T) {
	ts := newTestServer(t)

	ts.srv.On("compute", func(_ *socket.Client, args []json.RawMessage, ack func(...interface{})) {
		var n int
		_ = json.Unmarshal(args[0], &n)
		ack(n*2, "done")
	})

	conn := dial(t, ts)
	conn.sendEventWithAck(1, "compute", 21)

	arr := conn.readMsg()
	require.Len(t, arr, 4, "expected [_ack_, id, result, status]")
	assert.Equal(t, "_ack_", arr[0])
	assert.EqualValues(t, 1, arr[1])
	assert.EqualValues(t, 42, arr[2])
	assert.Equal(t, "done", arr[3])
}

func TestEventHandler_NoHandlerRegistered_NoResponse(t *testing.T) {
	ts := newTestServer(t)
	// no handlers registered

	conn := dial(t, ts)
	conn.sendEventWithAck(99, "unknown_event")

	// Nothing should arrive.
	conn.expectNoMsg(300 * time.Millisecond)
}

func TestEventHandler_ReplacedBySecondOn(t *testing.T) {
	ts := newTestServer(t)

	calls := make(chan string, 2)
	ts.srv.On("greet", func(_ *socket.Client, _ []json.RawMessage, _ func(...interface{})) {
		calls <- "first"
	})
	ts.srv.On("greet", func(_ *socket.Client, _ []json.RawMessage, _ func(...interface{})) {
		calls <- "second"
	})

	conn := dial(t, ts)
	conn.sendEvent("greet")

	select {
	case which := <-calls:
		assert.Equal(t, "second", which, "second registration should replace first")
	case <-time.After(msgTimeout):
		t.Fatal("handler did not fire")
	}

	// No second call.
	select {
	case extra := <-calls:
		t.Fatalf("unexpected extra call: %s", extra)
	case <-time.After(50 * time.Millisecond):
	}
}

// ---------------------------------------------------------------------------
// Room membership
// ---------------------------------------------------------------------------

func TestJoinRoom_IsMember(t *testing.T) {
	ts := newTestServer(t)

	joined := make(chan *socket.Client, 1)
	ts.srv.On("subscribe", func(c *socket.Client, args []json.RawMessage, ack func(...interface{})) {
		var room string
		_ = json.Unmarshal(args[0], &room)
		require.NoError(t, c.Join(room))
		joined <- c
		ack("ok")
	})

	conn := dial(t, ts)
	conn.sendEventWithAck(1, "subscribe", "sports")
	conn.readMsgEvent("_ack_") // consume ack

	select {
	case c := <-joined:
		assert.True(t, ts.srv.Hub().IsMember(c, "sports"))
		assert.False(t, ts.srv.Hub().IsMember(c, "other"))
	case <-time.After(msgTimeout):
		t.Fatal("subscribe handler did not fire")
	}
}

func TestLeaveRoom_NotMemberAfterLeave(t *testing.T) {
	ts := newTestServer(t)

	var serverClient *socket.Client
	ts.srv.On("subscribe", func(c *socket.Client, args []json.RawMessage, ack func(...interface{})) {
		var room string
		_ = json.Unmarshal(args[0], &room)
		_ = c.Join(room)
		serverClient = c
		ack("ok")
	})
	ts.srv.On("unsubscribe", func(c *socket.Client, args []json.RawMessage, ack func(...interface{})) {
		var room string
		_ = json.Unmarshal(args[0], &room)
		c.Leave(room)
		ack("ok")
	})

	conn := dial(t, ts)
	conn.sendEventWithAck(1, "subscribe", "news")
	conn.readMsgEvent("_ack_")

	conn.sendEventWithAck(2, "unsubscribe", "news")
	conn.readMsgEvent("_ack_")

	assert.False(t, ts.srv.Hub().IsMember(serverClient, "news"))
}

func TestJoinRoom_EmptyRoomError(t *testing.T) {
	ts := newTestServer(t)

	done := make(chan error, 1)
	ts.srv.On("subscribe", func(c *socket.Client, args []json.RawMessage, _ func(...interface{})) {
		var room string
		_ = json.Unmarshal(args[0], &room)
		done <- c.Join(room)
	})

	conn := dial(t, ts)
	conn.sendEvent("subscribe", "")

	select {
	case err := <-done:
		assert.ErrorIs(t, err, socket.ErrRoomRequired)
	case <-time.After(msgTimeout):
		t.Fatal("handler did not fire")
	}
}

// ---------------------------------------------------------------------------
// Broadcast
// ---------------------------------------------------------------------------

func TestBroadcast_MemberReceivesMessage(t *testing.T) {
	ts := newTestServer(t)
	registerRoomHandlers(t, ts)

	conn := dial(t, ts)
	conn.sendEventWithAck(1, "subscribe", "general")
	conn.readMsgEvent("_ack_")

	conn.sendEventWithAck(2, "broadcast", "general", map[string]string{"text": "hi"})

	// Sender receives both the broadcast ack and the message itself (they're in
	// the room). Collect both frames — order is not guaranteed.
	frames := conn.readMsgs(2)

	ackArgs := findEvent(t, frames, "_ack_")
	require.Len(t, ackArgs, 2) // [ackID, result]

	msgArgs := findEvent(t, frames, "message")
	require.Len(t, msgArgs, 1)
	b, _ := json.Marshal(msgArgs[0])
	var payload map[string]interface{}
	require.NoError(t, json.Unmarshal(b, &payload))
	inner, _ := payload["payload"].(map[string]interface{})
	assert.Equal(t, "hi", inner["text"])
}

func TestBroadcast_NonMemberCannotBroadcast(t *testing.T) {
	ts := newTestServer(t)
	registerRoomHandlers(t, ts)

	conn := dial(t, ts)
	// Do NOT join the room; attempt broadcast directly.
	conn.sendEventWithAck(1, "broadcast", "secret", map[string]string{"text": "intruder"})

	arr := conn.readMsg() // ack
	require.Len(t, arr, 3, "expected _ack_ response")
	assert.Equal(t, "_ack_", arr[0])

	b, _ := json.Marshal(arr[2])
	var result map[string]interface{}
	require.NoError(t, json.Unmarshal(b, &result))
	assert.Equal(t, false, result["ok"])
	assert.Contains(t, result["error"], "not a member")
}

func TestBroadcast_AllMembersReceive(t *testing.T) {
	ts := newTestServer(t)
	registerRoomHandlers(t, ts)

	const room = "lobby"
	// Three clients all join the same room.
	c1 := dial(t, ts)
	c2 := dial(t, ts)
	c3 := dial(t, ts)

	for i, c := range []*wsConn{c1, c2, c3} {
		c.sendEventWithAck(i+1, "subscribe", room)
		c.readMsgEvent("_ack_")
	}

	// c1 broadcasts. It receives both a "message" (it's a member) and "_ack_".
	c1.sendEventWithAck(10, "broadcast", room, map[string]string{"from": "c1"})
	c1frames := c1.readMsgs(2)
	findEvent(t, c1frames, "_ack_")
	c1msg := findEvent(t, c1frames, "message")
	require.Len(t, c1msg, 1)

	// c2 and c3 each receive only the "message" event.
	for _, c := range []*wsConn{c2, c3} {
		args := c.readMsgEvent("message")
		require.Len(t, args, 1, "message should have 1 arg")
		b, _ := json.Marshal(args[0])
		var payload map[string]interface{}
		require.NoError(t, json.Unmarshal(b, &payload))
		inner, _ := payload["payload"].(map[string]interface{})
		assert.Equal(t, "c1", inner["from"])
	}
}

func TestBroadcast_NonMemberDoesNotReceive(t *testing.T) {
	ts := newTestServer(t)
	registerRoomHandlers(t, ts)

	const room = "vip"
	member := dial(t, ts)
	outsider := dial(t, ts)

	member.sendEventWithAck(1, "subscribe", room)
	member.readMsgEvent("_ack_")
	// outsider never joins.

	member.sendEventWithAck(2, "broadcast", room, map[string]string{"msg": "secret"})
	frames := member.readMsgs(2) // "_ack_" + "message" (member receives own broadcast)
	findEvent(t, frames, "_ack_")
	findEvent(t, frames, "message")

	// Outsider should receive nothing.
	outsider.expectNoMsg(300 * time.Millisecond)
}

func TestBroadcast_AfterLeave_MemberNoLongerReceives(t *testing.T) {
	ts := newTestServer(t)
	registerRoomHandlers(t, ts)

	const room = "temp"
	c1 := dial(t, ts)
	c2 := dial(t, ts)

	// Both join.
	for i, c := range []*wsConn{c1, c2} {
		c.sendEventWithAck(i+1, "subscribe", room)
		c.readMsgEvent("_ack_")
	}

	// c2 leaves.
	c2.sendEventWithAck(10, "unsubscribe", room)
	c2.readMsgEvent("_ack_")

	// c1 broadcasts. Receives both "_ack_" and "message" (still a member).
	c1.sendEventWithAck(11, "broadcast", room, "hello")
	c1frames := c1.readMsgs(2)
	findEvent(t, c1frames, "_ack_")
	findEvent(t, c1frames, "message")

	// c2 has left and should receive nothing.
	c2.expectNoMsg(300 * time.Millisecond)
}

// ---------------------------------------------------------------------------
// Disconnect cleanup
// ---------------------------------------------------------------------------

func TestDisconnect_RemovesClientFromHub(t *testing.T) {
	ts := newTestServer(t)

	done := make(chan *socket.Client, 1)
	ts.srv.OnDisconnect = func(c *socket.Client) { done <- c }

	var serverClient *socket.Client
	ts.srv.On("join", func(c *socket.Client, args []json.RawMessage, _ func(...interface{})) {
		var room string
		_ = json.Unmarshal(args[0], &room)
		_ = c.Join(room)
		serverClient = c
	})

	conn := dial(t, ts)
	conn.sendEvent("join", "room1")
	time.Sleep(50 * time.Millisecond) // let server process join

	conn.close()

	select {
	case <-done:
		assert.False(t, ts.srv.Hub().IsMember(serverClient, "room1"),
			"client should be removed from room on disconnect")
	case <-time.After(msgTimeout):
		t.Fatal("OnDisconnect did not fire")
	}
}

func TestDisconnect_OnDisconnectFiresOnce(t *testing.T) {
	ts := newTestServer(t)

	var count atomic.Int32
	ts.srv.OnDisconnect = func(_ *socket.Client) { count.Add(1) }

	conn := dial(t, ts)
	conn.close()
	time.Sleep(200 * time.Millisecond)

	assert.Equal(t, int32(1), count.Load(), "OnDisconnect should fire exactly once")
}

// ---------------------------------------------------------------------------
// Resilience
// ---------------------------------------------------------------------------

func TestIgnoresInvalidJSON(t *testing.T) {
	ts := newTestServer(t)

	received := make(chan struct{}, 1)
	ts.srv.On("valid", func(_ *socket.Client, _ []json.RawMessage, _ func(...interface{})) {
		received <- struct{}{}
	})

	conn := dial(t, ts)

	// Send garbage — server should swallow it silently.
	require.NoError(t, conn.conn.WriteMessage(websocket.TextMessage, []byte("not json at all")))
	require.NoError(t, conn.conn.WriteMessage(websocket.TextMessage, []byte("{}")))       // object, not array
	require.NoError(t, conn.conn.WriteMessage(websocket.TextMessage, []byte("[]")))       // empty array

	// Followed by a valid event — should still be processed.
	conn.sendEvent("valid")

	select {
	case <-received:
	case <-time.After(msgTimeout):
		t.Fatal("valid event after bad frames was not handled")
	}
}

func TestConcurrentClients_AllConnect(t *testing.T) {
	ts := newTestServer(t)

	const n = 20
	var count atomic.Int32
	var wg sync.WaitGroup
	wg.Add(n)
	ts.srv.OnConnect = func(_ *socket.Client, _ *http.Request) {
		count.Add(1)
		wg.Done()
	}

	for i := 0; i < n; i++ {
		dial(t, ts)
	}

	select {
	case <-waitChan(&wg):
	case <-time.After(5 * time.Second):
		t.Fatalf("only %d/%d clients connected", count.Load(), n)
	}
	assert.Equal(t, int32(n), count.Load())
}

func TestConcurrentBroadcast(t *testing.T) {
	ts := newTestServer(t)
	registerRoomHandlers(t, ts)

	const (
		room      = "race"
		senders   = 5
		receivers = 10
	)

	// receivers all join the room.
	rconns := make([]*wsConn, receivers)
	for i := range rconns {
		c := dial(t, ts)
		rconns[i] = c
		c.sendEventWithAck(i+1, "subscribe", room)
		c.readMsgEvent("_ack_")
	}

	// senders join and then all broadcast concurrently.
	sconns := make([]*wsConn, senders)
	for i := range sconns {
		c := dial(t, ts)
		sconns[i] = c
		c.sendEventWithAck(i+1, "subscribe", room)
		c.readMsgEvent("_ack_")
	}

	var sendWg sync.WaitGroup
	for i, c := range sconns {
		sendWg.Add(1)
		go func(idx int, conn *wsConn) {
			defer sendWg.Done()
			conn.sendEventWithAck(100+idx, "broadcast", room, fmt.Sprintf("msg-%d", idx))
		}(i, c)
	}
	sendWg.Wait()

	// Each receiver should get exactly `senders` messages.
	// Drain with a generous timeout; order is not guaranteed.
	for _, c := range rconns {
		for i := 0; i < senders; i++ {
			_ = c.conn.SetReadDeadline(time.Now().Add(msgTimeout))
			_, _, err := c.conn.ReadMessage() // may be ack or message — just drain
			if err != nil {
				break
			}
		}
	}
	// If no panic/deadlock occurred, the test passes.
}

// ---------------------------------------------------------------------------
// registerRoomHandlers sets up subscribe / unsubscribe / broadcast on a server
// exactly as test_ws.go does, so broadcast tests have the membership check.
// ---------------------------------------------------------------------------
func registerRoomHandlers(t *testing.T, ts *testServer) {
	t.Helper()

	ts.srv.On("subscribe", func(c *socket.Client, args []json.RawMessage, ack func(...interface{})) {
		if len(args) == 0 {
			ack(map[string]interface{}{"ok": false, "error": "room required"})
			return
		}
		var room string
		if err := json.Unmarshal(args[0], &room); err != nil || room == "" {
			ack(map[string]interface{}{"ok": false, "error": "invalid room"})
			return
		}
		if err := c.Join(room); err != nil {
			ack(map[string]interface{}{"ok": false, "error": err.Error()})
			return
		}
		ack(map[string]interface{}{"ok": true})
	})

	ts.srv.On("unsubscribe", func(c *socket.Client, args []json.RawMessage, ack func(...interface{})) {
		if len(args) == 0 {
			ack(map[string]interface{}{"ok": false, "error": "room required"})
			return
		}
		var room string
		if err := json.Unmarshal(args[0], &room); err != nil || room == "" {
			ack(map[string]interface{}{"ok": false, "error": "invalid room"})
			return
		}
		c.Leave(room)
		ack(map[string]interface{}{"ok": true})
	})

	ts.srv.On("broadcast", func(c *socket.Client, args []json.RawMessage, ack func(...interface{})) {
		if len(args) < 2 {
			ack(map[string]interface{}{"ok": false, "error": "usage: broadcast <room> <payload>"})
			return
		}
		var room string
		if err := json.Unmarshal(args[0], &room); err != nil || room == "" {
			ack(map[string]interface{}{"ok": false, "error": "invalid room"})
			return
		}
		if !ts.srv.Hub().IsMember(c, room) {
			ack(map[string]interface{}{"ok": false, "error": "not a member of room " + room})
			return
		}
		type msg struct {
			From    string          `json:"from"`
			Payload json.RawMessage `json:"payload"`
		}
		payload, _ := json.Marshal(msg{From: c.ID, Payload: args[1]})
		frame, _ := (&socket.Packet{
			Type:  socket.MessageTypeEvent,
			Event: "message",
			Args:  []json.RawMessage{payload},
		}).MarshalJSON()
		_ = ts.srv.Hub().Publish(room, frame)
		ack(map[string]interface{}{"ok": true})
	})
}
