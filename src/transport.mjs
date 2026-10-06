// Browser WebSockets must come from the inspector or this loopback relay.
export function acceptsOrigin(origin, port) {
  return (
    !origin ||
    origin === 'devtools://devtools' ||
    origin === `http://127.0.0.1:${port}` ||
    origin === `http://localhost:${port}`
  )
}
