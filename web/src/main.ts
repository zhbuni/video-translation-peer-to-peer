type Envelope =
  | { type: "join"; payload: { roomId: string; peerId: string } }
  | { type: "peers"; payload: { peers: string[] } }
  | { type: "peer-joined"; payload: { peerId: string } }
  | { type: "peer-left"; payload: { peerId: string } }
  | { type: "offer"; payload: { to: string; from?: string; sdp: string } }
  | { type: "answer"; payload: { to: string; from?: string; sdp: string } }
  | {
      type: "ice";
      payload: { to: string; from?: string; candidate: RTCIceCandidateInit };
    }
  | { type: "error"; payload: { message: string } };

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const signalingUrlEl = $("signalingUrl") as HTMLInputElement;
const roomIdEl = $("roomId") as HTMLInputElement;
const peerIdEl = $("peerId") as HTMLInputElement;
const stunUrlsEl = $("stunUrls") as HTMLInputElement;
const turnUrlEl = $("turnUrl") as HTMLInputElement;
const turnUserEl = $("turnUser") as HTMLInputElement;
const turnPassEl = $("turnPass") as HTMLInputElement;
const qualityResEl = $("qualityRes") as HTMLSelectElement;
const qualityFpsEl = $("qualityFps") as HTMLSelectElement;
const maxKbpsEl = $("maxKbps") as HTMLInputElement;
const joinBtn = $("joinBtn") as HTMLButtonElement;
const startBtn = $("startBtn") as HTMLButtonElement;
const leaveBtn = $("leaveBtn") as HTMLButtonElement;
const statusEl = $("status") as HTMLPreElement;
const statsEl = $("stats") as HTMLPreElement;
const videosEl = $("videos") as HTMLDivElement;

function randId() {
  return Math.random().toString(16).slice(2, 8);
}

function defaultSignalingUrl() {
  const envUrl = import.meta.env.VITE_SIGNALING_URL as string | undefined;
  if (envUrl && envUrl.trim()) return envUrl.trim();

  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws`;
}

signalingUrlEl.value = defaultSignalingUrl();

const storageKey = "p2p-webrtc.settings.v1";
type StoredSettings = {
  signalingUrl?: string;
  roomId?: string;
  peerId?: string;
  stunUrls?: string;
  turnUrl?: string;
  turnUser?: string;
  turnPass?: string;
  qualityRes?: string;
  qualityFps?: string;
  maxKbps?: string;
};

function loadSettings(): StoredSettings {
  try {
    return JSON.parse(localStorage.getItem(storageKey) ?? "{}") as StoredSettings;
  } catch {
    return {};
  }
}

function saveSettings() {
  const s: StoredSettings = {
    signalingUrl: signalingUrlEl.value.trim(),
    roomId: roomIdEl.value.trim(),
    peerId: peerIdEl.value.trim(),
    stunUrls: stunUrlsEl.value.trim(),
    turnUrl: turnUrlEl.value.trim(),
    turnUser: turnUserEl.value.trim(),
    turnPass: turnPassEl.value,
    qualityRes: qualityResEl.value,
    qualityFps: qualityFpsEl.value,
    maxKbps: maxKbpsEl.value.trim(),
  };
  localStorage.setItem(storageKey, JSON.stringify(s));
}

const loaded = loadSettings();
roomIdEl.value = loaded.roomId ?? "demo";
peerIdEl.value = loaded.peerId ?? `peer-${randId()}`;
signalingUrlEl.value = loaded.signalingUrl ?? signalingUrlEl.value;
stunUrlsEl.value =
  loaded.stunUrls ??
  (import.meta.env.VITE_STUN_URLS ?? "stun:stun.l.google.com:19302");
turnUrlEl.value = loaded.turnUrl ?? (import.meta.env.VITE_TURN_URL ?? "");
turnUserEl.value = loaded.turnUser ?? (import.meta.env.VITE_TURN_USER ?? "");
turnPassEl.value = loaded.turnPass ?? (import.meta.env.VITE_TURN_PASS ?? "");
qualityResEl.value = loaded.qualityRes ?? "720";
qualityFpsEl.value = loaded.qualityFps ?? "15";
maxKbpsEl.value = loaded.maxKbps ?? "2500";

[
  signalingUrlEl,
  roomIdEl,
  peerIdEl,
  stunUrlsEl,
  turnUrlEl,
  turnUserEl,
  turnPassEl,
  maxKbpsEl,
].forEach((el) => el.addEventListener("input", () => saveSettings()));
[
  qualityResEl,
  qualityFpsEl,
].forEach((el) => el.addEventListener("change", () => saveSettings()));

let ws: WebSocket | null = null;
let myPeerId = "";
let myRoomId = "";

let localStream: MediaStream | null = null;

type PeerState = {
  pc: RTCPeerConnection;
  remoteStream: MediaStream;
  videoEl: HTMLVideoElement;
  makingOffer: boolean;
  ignoreOffer: boolean;
  pendingCandidates: RTCIceCandidateInit[];
  polite: boolean;
};

const peers = new Map<string, PeerState>();

type PeerStatsSnapshot = {
  tsMs: number;
  bytesSent: number;
  bytesReceived: number;
};

const lastSnapshot = new Map<string, PeerStatsSnapshot>();

function fmtKbps(bps: number) {
  if (!Number.isFinite(bps) || bps < 0) return "-";
  return `${Math.round(bps / 1000)} kbps`;
}

function fmtPct(v: number) {
  if (!Number.isFinite(v) || v < 0) return "-";
  return `${(v * 100).toFixed(1)}%`;
}

async function collectStatsOnce() {
  const lines: string[] = [];
  const now = Date.now();

  for (const [peerId, st] of peers) {
    const pc = st.pc;
    const report = await pc.getStats();

    let bytesSent = 0;
    let bytesReceived = 0;
    let packetsLostIn: number | null = null;
    let packetsIn: number | null = null;
    let currentRttMs: number | null = null;
    let selectedCandidate: string | null = null;

    report.forEach((r) => {
      if (r.type === "outbound-rtp" && !("isRemote" in r && (r as any).isRemote)) {
        const rr = r as any;
        if (typeof rr.bytesSent === "number") bytesSent += rr.bytesSent;
      }
      if (r.type === "inbound-rtp" && !("isRemote" in r && (r as any).isRemote)) {
        const rr = r as any;
        if (typeof rr.bytesReceived === "number") bytesReceived += rr.bytesReceived;
        if (typeof rr.packetsLost === "number") packetsLostIn = (packetsLostIn ?? 0) + rr.packetsLost;
        if (typeof rr.packetsReceived === "number") packetsIn = (packetsIn ?? 0) + rr.packetsReceived;
      }
      if (r.type === "candidate-pair") {
        const rr = r as any;
        if (rr.state === "succeeded" && rr.nominated) {
          if (typeof rr.currentRoundTripTime === "number") {
            currentRttMs = rr.currentRoundTripTime * 1000;
          }
          if (typeof rr.localCandidateId === "string" && typeof rr.remoteCandidateId === "string") {
            selectedCandidate = `pair=${rr.localCandidateId.slice(0, 6)}…/${rr.remoteCandidateId.slice(0, 6)}…`;
          }
        }
      }
    });

    const prev = lastSnapshot.get(peerId);
    let outKbps = NaN;
    let inKbps = NaN;
    if (prev) {
      const dt = (now - prev.tsMs) / 1000;
      if (dt > 0) {
        outKbps = ((bytesSent - prev.bytesSent) * 8) / dt;
        inKbps = ((bytesReceived - prev.bytesReceived) * 8) / dt;
      }
    }
    lastSnapshot.set(peerId, { tsMs: now, bytesSent, bytesReceived });

    const loss =
      packetsLostIn != null && packetsIn != null && packetsIn + packetsLostIn > 0
        ? packetsLostIn / (packetsIn + packetsLostIn)
        : NaN;

    lines.push(
      [
        peerId,
        `conn=${pc.connectionState}`,
        `ice=${pc.iceConnectionState}`,
        `in=${fmtKbps(inKbps)}`,
        `out=${fmtKbps(outKbps)}`,
        `rtt=${currentRttMs != null ? `${Math.round(currentRttMs)} ms` : "-"}`,
        `loss=${fmtPct(loss)}`,
        selectedCandidate ?? "",
      ]
        .filter(Boolean)
        .join("  "),
    );
  }

  statsEl.textContent = lines.length ? lines.join("\n") : "(no peers)";
}

let statsTimer: number | null = null;

function logStatus(line: string) {
  const ts = new Date().toISOString().slice(11, 19);
  statusEl.textContent = `[${ts}] ${line}\n${statusEl.textContent ?? ""}`.slice(
    0,
    6000,
  );
}

function setUi(state: "idle" | "joined") {
  const joined = state === "joined";
  joinBtn.disabled = joined;
  startBtn.disabled = !joined;
  leaveBtn.disabled = !joined;
  signalingUrlEl.disabled = joined;
  roomIdEl.disabled = joined;
  peerIdEl.disabled = joined;
  stunUrlsEl.disabled = joined;
  turnUrlEl.disabled = joined;
  turnUserEl.disabled = joined;
  turnPassEl.disabled = joined;
  qualityResEl.disabled = false;
  qualityFpsEl.disabled = false;
  maxKbpsEl.disabled = false;
}

function parseMaxBitrateBps(): number | null {
  const v = maxKbpsEl.value.trim();
  if (!v) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 1000);
}

function desiredVideoConstraints(): MediaTrackConstraints {
  const h = Number(qualityResEl.value) || 720;
  const fps = Number(qualityFpsEl.value) || 15;
  // For screen share, height/fps are the most predictable knobs.
  return {
    height: { ideal: h, max: h },
    frameRate: { ideal: fps, max: fps },
  };
}

async function applyVideoQualityToLocalTrack() {
  const track = localStream?.getVideoTracks()?.[0];
  if (!track) return;
  try {
    await track.applyConstraints(desiredVideoConstraints());
    const s = track.getSettings();
    logStatus(
      `video settings: ${s.width ?? "?"}x${s.height ?? "?"} @ ${s.frameRate ?? "?"}fps`,
    );
  } catch (e) {
    logStatus(`applyConstraints failed: ${(e as Error).message}`);
  }
}

async function applyBitrateToAllSenders() {
  const maxBps = parseMaxBitrateBps();
  for (const [, st] of peers) {
    for (const sender of st.pc.getSenders()) {
      const track = sender.track;
      if (!track || track.kind !== "video") continue;
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      for (const enc of params.encodings) {
        if (maxBps == null) {
          delete (enc as any).maxBitrate;
        } else {
          (enc as any).maxBitrate = maxBps;
        }
      }
      try {
        await sender.setParameters(params);
      } catch (e) {
        logStatus(`setParameters failed: ${(e as Error).message}`);
      }
    }
  }
}

function parseIceServers(): RTCIceServer[] {
  const stun = stunUrlsEl.value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const servers: RTCIceServer[] = [];
  if (stun.length) {
    servers.push({ urls: stun });
  }

  const turnUrl = turnUrlEl.value.trim();
  const username = turnUserEl.value.trim();
  const credential = turnPassEl.value;
  if (turnUrl) {
    const turn: RTCIceServer = { urls: [turnUrl] };
    if (username) turn.username = username;
    if (credential) turn.credential = credential;
    servers.push(turn);
  }

  // If empty, let browser decide defaults (but usually you'd want at least STUN).
  return servers;
}

function ensureLocalPreview() {
  const id = "__local__";
  const existing = document.getElementById(id);
  if (existing) return existing as HTMLVideoElement;

  const tile = document.createElement("div");
  tile.className = "tile";

  const v = document.createElement("video");
  v.id = id;
  v.autoplay = true;
  v.muted = true;
  v.playsInline = true;

  const badge = document.createElement("div");
  badge.className = "badge";
  badge.textContent = `local (${myPeerId || "?"})`;

  tile.appendChild(v);
  tile.appendChild(badge);
  videosEl.prepend(tile);
  return v;
}

function addRemoteTile(peerId: string): HTMLVideoElement {
  const tile = document.createElement("div");
  tile.className = "tile";

  const v = document.createElement("video");
  v.autoplay = true;
  v.muted = false;
  v.playsInline = true;

  const badge = document.createElement("div");
  badge.className = "badge";
  badge.textContent = peerId;

  tile.appendChild(v);
  tile.appendChild(badge);
  videosEl.appendChild(tile);
  return v;
}

function removePeer(peerId: string) {
  const st = peers.get(peerId);
  if (!st) return;
  peers.delete(peerId);
  lastSnapshot.delete(peerId);
  st.pc.close();
  st.videoEl.srcObject = null;
  const tile = st.videoEl.parentElement;
  tile?.remove();
}

function shouldInitiate(peerId: string) {
  // Deterministic initiator to avoid glare in mesh:
  // smaller peerId creates offers.
  return myPeerId.localeCompare(peerId) < 0;
}

function createPC(remotePeerId: string): PeerState {
  const pc = new RTCPeerConnection({
    iceServers: parseIceServers(),
  });

  const remoteStream = new MediaStream();
  const videoEl = addRemoteTile(remotePeerId);
  videoEl.srcObject = remoteStream;

  const polite = myPeerId.localeCompare(remotePeerId) > 0;
  const st: PeerState = {
    pc,
    remoteStream,
    videoEl,
    makingOffer: false,
    ignoreOffer: false,
    pendingCandidates: [],
    polite,
  };

  pc.onicecandidate = (ev) => {
    if (!ev.candidate || !ws) return;
    send({
      type: "ice",
      payload: { to: remotePeerId, candidate: ev.candidate.toJSON() },
    });
  };

  pc.onconnectionstatechange = () => {
    logStatus(`pc(${remotePeerId}) conn=${pc.connectionState}`);
    if (pc.connectionState === "failed" || pc.connectionState === "closed") {
      removePeer(remotePeerId);
    }
  };

  pc.oniceconnectionstatechange = () => {
    logStatus(`pc(${remotePeerId}) ice=${pc.iceConnectionState}`);
  };

  pc.ontrack = (ev) => {
    remoteStream.addTrack(ev.track);
  };

  pc.onnegotiationneeded = async () => {
    try {
      st.makingOffer = true;
      const offer = await pc.createOffer();
      // If we're not stable, negotiation will be handled by the other side.
      if (pc.signalingState !== "stable") return;
      await pc.setLocalDescription(offer);
      send({
        type: "offer",
        payload: { to: remotePeerId, sdp: pc.localDescription?.sdp ?? "" },
      });
    } catch (e) {
      logStatus(`negotiationneeded(${remotePeerId}) failed: ${(e as Error).message}`);
    } finally {
      st.makingOffer = false;
    }
  };

  if (localStream) {
    for (const track of localStream.getTracks()) {
      pc.addTrack(track, localStream);
    }
  }

  peers.set(remotePeerId, st);
  return st;
}

async function ensurePC(remotePeerId: string) {
  return peers.get(remotePeerId) ?? createPC(remotePeerId);
}

async function makeOffer(toPeerId: string) {
  const st = await ensurePC(toPeerId);
  // With perfect negotiation, offers are primarily driven by onnegotiationneeded,
  // but we still keep this helper for initial connect.
  const offer = await st.pc.createOffer();
  await st.pc.setLocalDescription(offer);
  send({
    type: "offer",
    payload: { to: toPeerId, sdp: offer.sdp ?? "" },
  });
}

function send(msg: Envelope) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(msg));
}

async function handleMessage(msg: Envelope) {
  switch (msg.type) {
    case "peers": {
      logStatus(`peers: ${msg.payload.peers.join(", ") || "(none)"}`);
      for (const p of msg.payload.peers) {
        await ensurePC(p);
        // Kick initial negotiation deterministically; subsequent renegotiation is event-driven.
        if (shouldInitiate(p)) await makeOffer(p);
      }
      break;
    }
    case "peer-joined": {
      const p = msg.payload.peerId;
      logStatus(`peer-joined: ${p}`);
      await ensurePC(p);
      if (shouldInitiate(p)) await makeOffer(p);
      break;
    }
    case "peer-left": {
      const p = msg.payload.peerId;
      logStatus(`peer-left: ${p}`);
      removePeer(p);
      break;
    }
    case "offer": {
      const from = msg.payload.from!;
      const st = await ensurePC(from);
      const offerDesc = { type: "offer" as const, sdp: msg.payload.sdp };
      const offerCollision =
        st.makingOffer || st.pc.signalingState !== "stable";
      st.ignoreOffer = !st.polite && offerCollision;

      if (st.ignoreOffer) {
        logStatus(`offer ignored from=${from} (collision)`);
        return;
      }

      await st.pc.setRemoteDescription(offerDesc);
      // Apply queued ICE now that remote description is set.
      for (const c of st.pendingCandidates.splice(0)) {
        try {
          await st.pc.addIceCandidate(c);
        } catch (e) {
          logStatus(`queued ice add failed from=${from}: ${(e as Error).message}`);
        }
      }

      const ans = await st.pc.createAnswer();
      await st.pc.setLocalDescription(ans);
      send({
        type: "answer",
        payload: { to: from, sdp: st.pc.localDescription?.sdp ?? "" },
      });
      break;
    }
    case "answer": {
      const from = msg.payload.from!;
      const st = await ensurePC(from);
      await st.pc.setRemoteDescription({ type: "answer", sdp: msg.payload.sdp });
      for (const c of st.pendingCandidates.splice(0)) {
        try {
          await st.pc.addIceCandidate(c);
        } catch (e) {
          logStatus(`queued ice add failed from=${from}: ${(e as Error).message}`);
        }
      }
      break;
    }
    case "ice": {
      const from = msg.payload.from!;
      const st = await ensurePC(from);
      try {
        if (st.pc.remoteDescription) {
          await st.pc.addIceCandidate(msg.payload.candidate);
        } else {
          st.pendingCandidates.push(msg.payload.candidate);
        }
      } catch (e) {
        // Can happen if candidate arrives before remote description.
        logStatus(`ice add failed from=${from}: ${(e as Error).message}`);
      }
      break;
    }
    case "error":
      logStatus(`server error: ${msg.payload.message}`);
      break;
  }
}

async function join() {
  myPeerId = peerIdEl.value.trim();
  myRoomId = roomIdEl.value.trim();
  const url = signalingUrlEl.value.trim();
  if (!myPeerId || !myRoomId || !url) {
    logStatus("roomId/peerId/signalingUrl required");
    return;
  }

  saveSettings();
  logStatus(
    `iceServers: ${JSON.stringify(parseIceServers().map((s) => ({ urls: s.urls })))}`,
  );

  ws = new WebSocket(url);

  ws.onopen = () => {
    logStatus(`ws open: ${url}`);
    setUi("joined");
    send({ type: "join", payload: { roomId: myRoomId, peerId: myPeerId } });
    if (statsTimer == null) {
      statsTimer = window.setInterval(() => {
        void collectStatsOnce();
      }, 1000);
    }
  };
  ws.onclose = () => {
    logStatus("ws closed");
    cleanup();
  };
  ws.onerror = () => {
    logStatus("ws error");
  };
  ws.onmessage = async (ev) => {
    let msg: Envelope;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    await handleMessage(msg);
  };
}

async function startScreenMic() {
  if (localStream) return;
  const screen = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: false,
  });
  const mic = await navigator.mediaDevices.getUserMedia({ audio: true });

  localStream = new MediaStream();
  for (const t of screen.getTracks()) localStream.addTrack(t);
  for (const t of mic.getTracks()) localStream.addTrack(t);

  ensureLocalPreview().srcObject = localStream;
  logStatus(
    `local tracks: ${localStream.getTracks().map((t) => t.kind).join(", ")}`,
  );

  await applyVideoQualityToLocalTrack();

  // Add tracks to existing peer connections.
  for (const [, st] of peers) {
    for (const track of localStream.getTracks()) {
      st.pc.addTrack(track, localStream);
    }
  }

  // Renegotiation will happen via onnegotiationneeded on each peer connection.
  await applyBitrateToAllSenders();
}

function cleanup() {
  setUi("idle");
  if (ws) {
    try {
      ws.close();
    } catch {}
  }
  ws = null;

  for (const peerId of [...peers.keys()]) {
    removePeer(peerId);
  }

  if (localStream) {
    for (const t of localStream.getTracks()) t.stop();
  }
  localStream = null;

  // Keep local tile but clear stream
  const localV = document.getElementById("__local__") as HTMLVideoElement | null;
  if (localV) localV.srcObject = null;

  if (statsTimer != null) {
    window.clearInterval(statsTimer);
    statsTimer = null;
  }
  statsEl.textContent = "(no peers)";
}

joinBtn.onclick = () => void join();
startBtn.onclick = () => void startScreenMic();
leaveBtn.onclick = () => cleanup();

setUi("idle");
logStatus("ready");

qualityResEl.onchange = () => {
  saveSettings();
  void applyVideoQualityToLocalTrack();
};
qualityFpsEl.onchange = () => {
  saveSettings();
  void applyVideoQualityToLocalTrack();
};
maxKbpsEl.oninput = () => {
  saveSettings();
  void applyBitrateToAllSenders();
};

