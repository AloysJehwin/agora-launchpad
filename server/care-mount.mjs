// Plug-in point for the health companion app, which lives entirely in ../care and is built
// separately. It is loaded on first use; if the folder is missing or broken, the rest of the
// server carries on without it.
//
// ../care/index.mjs may export any of:
//   handleConsole(req, res, url)  -> true when it answered. Requests under /care on the operator
//                                    console listener (password-protected in production).
//   handlePublic(req, res, url)   -> true when it answered. Requests under /care on the public
//                                    listener, e.g. tool endpoints Agora calls during a call.
//   start()                       -> called once at boot (schedulers and the like).
//   stop()                        -> called on shutdown.
let mod = null;
const load = async () => {
  if (mod === null) {
    mod = await import('../care/index.mjs').catch((err) => {
      if (err.code !== 'ERR_MODULE_NOT_FOUND') console.warn(`care app failed to load: ${err.message}`);
      return false;
    });
  }
  return mod || null;
};

const guard = (name) => async (req, res, url) => {
  if (url.pathname !== '/care' && !url.pathname.startsWith('/care/')) return false;
  const care = await load();
  if (!care?.[name]) return false;
  try {
    return Boolean(await care[name](req, res, url));
  } catch (err) {
    console.error(`care ${name} ${req.method} ${url.pathname}: ${err.message}`);
    if (!res.headersSent) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'The health companion hit a problem.' })); }
    return true;
  }
};

export const careConsole = guard('handleConsole');
export const carePublic = guard('handlePublic');
export const careStart = async () => { const care = await load(); await care?.start?.(); };
export const careStop = async () => { const care = await load(); await care?.stop?.().catch?.(() => {}); };
