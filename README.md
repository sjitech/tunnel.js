# nodejs-tcp-mux-tunnel
Create a single connection as mux tunnel, so you can pipe multiple connections between local and remotes, even in a restricted network.

```
Usage:
 tcp-mux-tunnel.js server <listenAddress> <listenPort>
 tcp-mux-tunnel.js connect <serverAddress> <serverPort> forward <fromAddress>   <fromPort>   <toAddress_R> <toPort_R>
 tcp-mux-tunnel.js connect <serverAddress> <serverPort> reverse <fromAddress_R> <fromPort_R> <toAddress>   <toPort>
Notes:
 The "_R" suffix means the address and port is in sense of the tunnel server.
```
