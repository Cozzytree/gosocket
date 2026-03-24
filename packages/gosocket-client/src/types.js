// Socket.IO wire types
export var PacketType;
(function (PacketType) {
    PacketType[PacketType["Event"] = 2] = "Event";
    PacketType[PacketType["Ack"] = 3] = "Ack";
    PacketType[PacketType["Error"] = 4] = "Error";
})(PacketType || (PacketType = {}));
