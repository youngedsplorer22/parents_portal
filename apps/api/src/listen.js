// Starts listening where the configuration says. `host` is an address (development listens on 127.0.0.1 only) or null:
// with no host Node listens on every interface (dual-stack where available), which is what a hosting platform such as
// Railway needs, because it reaches the service on a non-loopback address.
export function listen(app, { port, host }, onListening) {
  return host ? app.listen(port, host, onListening) : app.listen(port, onListening);
}
