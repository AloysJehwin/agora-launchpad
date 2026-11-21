// Who is on the other end of each live conversation. A `ref` is the opaque id baked into an
// agent's tool definitions when a call, rehearsal or website conversation starts; tool requests
// carry it back so we know whose call it is. { to, name, slug?, talkId? }
export const callers = new Map();
export const registerCaller = (ref, info) => callers.set(ref, info);
