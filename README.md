# tunnel.js
Create a tunnel for port forwarding/reversing in most restricted network

Currently only support TCP tunnel and TCP forwarding/reversing.

TODO:
- Support TLS tunnel
- Support UNIX Domain Socket Tunnel
- Support SMB named pipe tunnel
- Support forwarding/reversing shell exec.
- Support authentication.

##Usage
(you can also install it by `npm install -g tunnel.js`)

- Tunnel Server
```
tunnel.js listen [localAddress:]port
```
- Tunnel Client
```
tunnel.js connect [host:]port [-source [localAddress:]port] ...
```
The Tunnel Client will read instructions from arguments and standard input.
```
forward [localAddress:]port [destHOST:]PORT
reverse [localADDRESS:]PORT [destHost:]port
end-forward [localAddress:]port
end-reverse [localADDRESS:]PORT
```
- Notes:
    - Uppercase args just means they are in sense of the tunnel server.
    - IPv6 address must be wrapped by square brackets, e.g. [::1]:8080

#Sample
Assume you have a network consisted of HOST_FOR_INNER and HOST_FOR_OUTER
- Network rules only allow HOST_FOR_INNER:1111 -> HOST_FOR_OUTER:2222, not reverse
- only HOST_FOR_OUTER can go to ANYWHERE_OUTSIDE
- only HOST_FOR_INNER can go to SOMEWHERE_INSIDE

## port forwarding
On HOST_FOR_INNER, you want to connect to SOMEWHERE_OUTSIDE:8888 via a local port 9999
which will be forwarded to the target. You can do it by following steps:
- on HOST_FOR_OUTER: Run a tunnel server
```
tunnel.js listen 2222
```
- on HOST_FOR_INNER: Connect to the tunnel server and instruct it to create a port forwarder
```
tunnel.js connect HOST_FOR_OUTER:2222 -source HOST_FOR_INNER:1111 \
 forward 9999 SOMEWHERE_OUTSIDE:8888
```

## port reversing
On HOST_FOR_OUTER, you want to connect to SOMEWHERE_INSIDE:8888 via a local port 9999
which will be forwarded to the target. You can just change the above forward command to reverse as following:
- on HOST_FOR_INNER: Connect to the tunnel server and instruct HOST_FOR_OUTER to create a port forwarder 
```
tunnel.js connect HOST_FOR_OUTER:2222 -source HOST_FOR_INNER:1111 \
 reverse 9999 SOMEWHERE_INSIDE:8888
```
