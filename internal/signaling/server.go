package signaling

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"sync"
	"time"

	"nhooyr.io/websocket"
	"nhooyr.io/websocket/wsjson"
)

type Server struct {
	logger *log.Logger

	mu    sync.Mutex
	rooms map[string]*room
}

type room struct {
	id    string
	peers map[string]*client
}

type client struct {
	peerID string
	roomID string
	conn   *websocket.Conn
}

func NewServer(logger *log.Logger) *Server {
	if logger == nil {
		logger = log.Default()
	}
	return &Server{
		logger: logger,
		rooms:  make(map[string]*room),
	}
}

func (s *Server) Handler() http.Handler {
	return http.HandlerFunc(s.handleWS)
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns: []string{"*"},
	})
	if err != nil {
		return
	}
	defer c.Close(websocket.StatusInternalError, "server error")

	ctx := r.Context()
	c.SetReadLimit(1 << 20) // 1MiB

	// First message must be join.
	var env Envelope
	if err := wsjson.Read(ctx, c, &env); err != nil {
		return
	}
	if env.Type != TypeJoin {
		_ = wsjson.Write(ctx, c, Envelope{Type: TypeError, Payload: mustJSON(ErrorPayload{Message: "first message must be join"})})
		c.Close(websocket.StatusPolicyViolation, "expected join")
		return
	}

	var join JoinPayload
	if err := json.Unmarshal(env.Payload, &join); err != nil || join.RoomID == "" || join.PeerID == "" {
		_ = wsjson.Write(ctx, c, Envelope{Type: TypeError, Payload: mustJSON(ErrorPayload{Message: "invalid join payload"})})
		c.Close(websocket.StatusPolicyViolation, "invalid join")
		return
	}

	cl := &client{
		peerID: join.PeerID,
		roomID: join.RoomID,
		conn:   c,
	}

	peerList, err := s.addClient(ctx, cl)
	if err != nil {
		_ = wsjson.Write(ctx, c, Envelope{Type: TypeError, Payload: mustJSON(ErrorPayload{Message: err.Error()})})
		c.Close(websocket.StatusPolicyViolation, "join rejected")
		return
	}

	// Send current peers to the joining client.
	_ = wsjson.Write(ctx, c, Envelope{Type: TypePeers, Payload: mustJSON(PeersPayload{Peers: peerList})})

	// Broadcast peer-joined to other peers in room.
	s.broadcastToRoom(join.RoomID, join.PeerID, Envelope{
		Type:    TypePeerJoined,
		Payload: mustJSON(PeerEventPayload{PeerID: join.PeerID}),
	})

	s.logger.Printf("ws connected room=%s peer=%s", join.RoomID, join.PeerID)

	// Main loop: route signaling messages.
	for {
		var in Envelope
		readCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
		err := wsjson.Read(readCtx, c, &in)
		cancel()
		if err != nil {
			if websocket.CloseStatus(err) != -1 || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				break
			}
			break
		}

		switch in.Type {
		case TypeOffer, TypeAnswer:
			var p SessionDescriptionPayload
			if err := json.Unmarshal(in.Payload, &p); err != nil || p.To == "" || p.SDP == "" {
				_ = wsjson.Write(ctx, c, Envelope{Type: TypeError, Payload: mustJSON(ErrorPayload{Message: "invalid sdp payload"})})
				continue
			}
			p.From = cl.peerID
			s.routeToPeer(cl.roomID, p.To, Envelope{Type: in.Type, Payload: mustJSON(p)})

		case TypeICE:
			var p ICEPayload
			if err := json.Unmarshal(in.Payload, &p); err != nil || p.To == "" || len(p.Candidate) == 0 {
				_ = wsjson.Write(ctx, c, Envelope{Type: TypeError, Payload: mustJSON(ErrorPayload{Message: "invalid ice payload"})})
				continue
			}
			p.From = cl.peerID
			s.routeToPeer(cl.roomID, p.To, Envelope{Type: TypeICE, Payload: mustJSON(p)})

		default:
			_ = wsjson.Write(ctx, c, Envelope{Type: TypeError, Payload: mustJSON(ErrorPayload{Message: "unknown message type"})})
		}
	}

	s.removeClient(cl)
	s.broadcastToRoom(join.RoomID, join.PeerID, Envelope{
		Type:    TypePeerLeft,
		Payload: mustJSON(PeerEventPayload{PeerID: join.PeerID}),
	})
	s.logger.Printf("ws disconnected room=%s peer=%s", join.RoomID, join.PeerID)

	c.Close(websocket.StatusNormalClosure, "bye")
}

func (s *Server) addClient(ctx context.Context, cl *client) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	rm := s.rooms[cl.roomID]
	if rm == nil {
		rm = &room{id: cl.roomID, peers: make(map[string]*client)}
		s.rooms[cl.roomID] = rm
	}
	if _, exists := rm.peers[cl.peerID]; exists {
		return nil, errors.New("peerId already exists in room")
	}
	peers := make([]string, 0, len(rm.peers))
	for id := range rm.peers {
		peers = append(peers, id)
	}
	rm.peers[cl.peerID] = cl
	return peers, nil
}

func (s *Server) removeClient(cl *client) {
	s.mu.Lock()
	defer s.mu.Unlock()

	rm := s.rooms[cl.roomID]
	if rm == nil {
		return
	}
	delete(rm.peers, cl.peerID)
	if len(rm.peers) == 0 {
		delete(s.rooms, cl.roomID)
	}
}

func (s *Server) routeToPeer(roomID, peerID string, msg Envelope) {
	s.mu.Lock()
	rm := s.rooms[roomID]
	var dst *client
	if rm != nil {
		dst = rm.peers[peerID]
	}
	s.mu.Unlock()
	if dst == nil {
		return
	}
	// Best-effort: if peer is slow/disconnected, write will fail and that's fine.
	_ = wsjson.Write(context.Background(), dst.conn, msg)
}

func (s *Server) broadcastToRoom(roomID, exceptPeerID string, msg Envelope) {
	s.mu.Lock()
	rm := s.rooms[roomID]
	var dsts []*client
	if rm != nil {
		dsts = make([]*client, 0, len(rm.peers))
		for id, cl := range rm.peers {
			if id == exceptPeerID {
				continue
			}
			dsts = append(dsts, cl)
		}
	}
	s.mu.Unlock()

	for _, cl := range dsts {
		_ = wsjson.Write(context.Background(), cl.conn, msg)
	}
}

func mustJSON(v any) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}

