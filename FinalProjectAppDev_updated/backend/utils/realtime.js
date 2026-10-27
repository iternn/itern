// Server-Sent Events hub: one open HTTP stream per browser tab, keyed by user.
const clients = new Map(); // "role:id" -> Set<res>

const key = (role, id) => `${role}:${id}`;

function addClient(role, id, res) {
  const k = key(role, id);
  if (!clients.has(k)) clients.set(k, new Set());
  clients.get(k).add(res);
  res.on('close', () => {
    clients.get(k)?.delete(res);
    if (!clients.get(k)?.size) clients.delete(k);
  });
}

function write(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
}

function emitTo(role, id, event, data) {
  clients.get(key(role, id))?.forEach((res) => write(res, event, data));
}

function broadcast(event, data) {
  clients.forEach((set) => set.forEach((res) => write(res, event, data)));
}

// Keeps proxies / browsers from closing idle streams.
setInterval(() => clients.forEach((set) => set.forEach((res) => res.write(': ping\n\n'))), 25000).unref();

module.exports = { addClient, emitTo, broadcast };
