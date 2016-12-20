'use strict';
const net = require('net');

function init_mux_tunnel(tunnel, tunnelTag, isTunnelServer) {
  tunnel._isTunnelServer = isTunnelServer;
  tunnel._lastForwarderId = 0;
  tunnel._tag = tunnelTag;
  tunnel._streamMap = {/*key is streamId*/};
  tunnel._targetMap = {/*key is forwarderId*/};
  tunnel._listenerMap = {/*key is forwarderId*/};
  const EMPTY_BUF = Buffer.alloc(0);
  let eventBuf = EMPTY_BUF;
  const EOF_CODE = '\n'.charAt(0);
  let curRealStream;

  tunnel.on('data', buf => {
    let restBuf = buf;
    while (restBuf && restBuf.length > 0) {
      buf = restBuf;
      restBuf = null;

      if (curRealStream) {
        //pipe tunnel incoming data to real stream
        curRealStream.write(buf.slice(0, curRealStream._restLenOfDataToRead));

        if (buf.length >= curRealStream._restLenOfDataToRead) {
          restBuf = buf.slice(curRealStream._restLenOfDataToRead);
          curRealStream._restLenOfDataToRead = 0;
          curRealStream = null;
        } else {
          curRealStream._restLenOfDataToRead -= buf.length;
        }
      } else {
        const pos = buf.indexOf(EOF_CODE);
        if (pos >= 0) {
          let event_s = Buffer.concat([eventBuf, buf.slice(0, pos)]).toString();
          console.log(tunnelTag + 'event: ' + event_s);
          if (buf.length > pos + 1) {
            restBuf = buf.slice(pos + 1);
          }
          eventBuf = EMPTY_BUF;

          curRealStream = handle_tunnel_event(tunnel, event_s.split('\t'));
        }
        else {
          eventBuf = Buffer.concat([eventBuf, buf]);
        }
      }
    }
  }).on('close', () => {
    console.log(tunnelTag + 'closed');

    for (let streamId in tunnel._streamMap) {
      tunnel._streamMap[streamId].destroy();
      tunnel._streamMap = {};
    }
    for (let forwarderId in tunnel._listenerMap) {
      tunnel._listenerMap[forwarderId].server.close();
      tunnel._listenerMap = {};
    }
    tunnel._targetMap = {};

  }).on('end', () => console.log(tunnelTag + 'EOF'))
    .on('error', e => console.log(tunnelTag + e));
}

function handle_tunnel_event(tunnel, args) {
  const streamId = args.shift();
  const eventName = args.shift();

  if (streamId) {
    const forwarderId = streamId.split('#')[0];

    if (streamId === forwarderId) { //listener events from peer
      switch (eventName) {
        case '+': //on listening
          tunnel._targetMap[forwarderId] = {
            host: args[0], port: args[1] | 0,
            info: {localADDRESS: args[2], localPORT: args[3] | 0, destHost: args[0], destPort: args[1] | 0}
          };
          return;
        case '-': //on close
          delete tunnel._targetMap[forwarderId];
          return;
      }
    }
    else { //stream events from peer
      let realStream = tunnel._streamMap[streamId];
      switch (eventName) {
        case '+': {//on connect
          let target = tunnel._targetMap[forwarderId];
          if (target) {
            console.log(`${tunnel._tag}[${streamId}] Connect to [${target.host}]:${target.port}`);
            realStream = net.connect(target, () =>
              console.log(`${tunnel._tag}[${streamId}] Connected to [${realStream.remoteAddress}]:${realStream.remotePort} source [${realStream.localAddress}]:${realStream.localPort}`)
            );
            tunnel._streamMap[streamId] = realStream;
            pipe_stream_to_tunnel(tunnel, realStream, streamId);
          }
          return;
        }
        case ':': { //on data
          let len = parseInt(args[0], 16);
          if (realStream && len > 0) {
            realStream._restLenOfDataToRead = len;
            return realStream;
          }
          return;
        }
        case '!': //on end
          if (realStream) {
            realStream.end();
          }
          return;
        case '-': //on close
          if (realStream) {
            realStream.destroy();
            delete tunnel._streamMap[streamId];
          }
          return;
      }
    }
  } else { //internal commands
    switch (eventName) {
      case 'forward':
        create_forwarder_listener(tunnel, args[0], args[1] | 0, args[2], args[3] | 0);
        return;
      case 'end-forward':
        end_forwarder_listener(tunnel, args[0], args[1] | 0);
        return;
    }
  }

  console.log(tunnel._tag + 'invalid event');
  tunnel.destroy();
}

function create_forwarder_listener(tunnel, localAddress, localPort, destHost, destPort) {
  console.log(tunnel._tag + 'Create port forwarder ' +
    JSON.stringify({localAddress, localPort, destHost, destPort}, null, '    '));

  const forwarderId = (tunnel._isTunnelServer ? 'F' : 'f') + (++tunnel._lastForwarderId).toString(16);
  let lastStreamId = 0;

  net.createServer({allowHalfOpen: true}, realStream => {
    const streamId = forwarderId + '#' + (++lastStreamId).toString(16);
    console.log(`${tunnel._tag}[${streamId}] Connected from [${realStream.remoteAddress}]:${realStream.remotePort}`);
    tunnel._streamMap[streamId] = realStream;

    tunnel.write(`${streamId}\t+\n`);

    pipe_stream_to_tunnel(tunnel, realStream, streamId);

  }).listen({host: localAddress, port: localPort}, function () {
    console.log(`${tunnel._tag}[${forwarderId}] Listening at [${this.address().address}]:${this.address().port}`);
    tunnel._listenerMap[forwarderId] = {server: this, info: {localAddress, localPort, destHost, destPort}};
    tunnel.write(`${forwarderId}\t+\t${destHost}\t${destPort}\t${localAddress}\t${localPort}\n`);

  }).on('close', () => {
    console.log(`${tunnel._tag}[${forwarderId}] Closed`);
    delete tunnel._listenerMap[forwarderId];
    tunnel.write(`${forwarderId}\t-\n`);
  }).on('error', function (e) {
    console.log(`${tunnel._tag}[${forwarderId}] ${e}`);
    this.close();
  });
}

function end_forwarder_listener(tunnel, localAddress, localPort) {
  console.log(tunnel._tag + 'End port forwarder ' + JSON.stringify({localAddress, localPort}, null, '    '));

  for (let forwarderId in tunnel._listenerMap) {
    let listener = tunnel._listenerMap[forwarderId];
    if ((!localAddress || listener.info.localAddress === localAddress || listener.server.address().address === localAddress)
      && (!localPort || listener.info.localPort === localPort || listener.server.address().port === localPort)) {
      listener.server.close();
      let forwarderId_ = forwarderId + '#';
      for (let streamId in tunnel._streamMap) {
        if (streamId.startsWith(forwarderId_)) {
          tunnel._streamMap[streamId].destroy();
        }
      }
      return;
    }
  }
}

function pipe_stream_to_tunnel(tunnel, realStream, streamId) {
  realStream
    .on('data', buf => {
      tunnel.cork();
      tunnel.write(`${streamId}\t:\t${buf.length.toString(16)}\n`);
      tunnel.write(buf);
      tunnel.uncork();
    })
    .on('end', () => {
      console.log(`${tunnel._tag}[${streamId}] EOF`);
      tunnel.write(`${streamId}\t!\n`);
    })
    .on('close', () => {
      console.log(`${tunnel._tag}[${streamId}] closed`);
      delete tunnel._streamMap[streamId];
      tunnel.write(`${streamId}\t-\n`);
    })
    .on('error', e => console.log(`${tunnel._tag}[${streamId}] ${e}`))
    .once('data', buf => console.log(`${tunnel._tag}[${streamId}] first data`))
}

module.exports = {init_mux_tunnel, create_forwarder_listener, end_forwarder_listener};