package signaling

import "encoding/json"

// Type values.
const (
	TypeJoin       = "join"
	TypePeers      = "peers"
	TypePeerJoined = "peer-joined"
	TypePeerLeft   = "peer-left"
	TypeOffer      = "offer"
	TypeAnswer     = "answer"
	TypeICE        = "ice"
	TypeError      = "error"
)

// Envelope is the top-level JSON structure for signaling messages.
// Payload is a raw JSON object whose shape depends on Type.
type Envelope struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

type JoinPayload struct {
	RoomID string `json:"roomId"`
	PeerID string `json:"peerId"`
}

type PeersPayload struct {
	Peers []string `json:"peers"`
}

type PeerEventPayload struct {
	PeerID string `json:"peerId"`
}

type SessionDescriptionPayload struct {
	To   string `json:"to"`
	From string `json:"from"`
	SDP  string `json:"sdp"`
}

type ICEPayload struct {
	To        string          `json:"to"`
	From      string          `json:"from"`
	Candidate json.RawMessage `json:"candidate"`
}

type ErrorPayload struct {
	Message string `json:"message"`
}
