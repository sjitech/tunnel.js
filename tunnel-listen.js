#!/usr/bin/env node
'use strict';
const net = require('net');
console.log = console.error;
const tunnelUtil = require('./tunnel.js');

function show_usage() {
  console.log('Create a tunnel server for port forwarding/reversing.');
  console.log('Usage:');
  console.log('  tunnel-listen.js [localAddress:]port');
  console.log('Note:');
  console.log('  IPv6 address must be wrapped by square brackets, e.g. [::1]:8080');
  process.exit(1);
}

function main(args) {
  if (args.length !== 1 || args[0] === '--help') return show_usage();
  let [localAddress, localPort] = split_host_port(args.shift());
  if (localPort != split_host_port.port_s) return console.log('invalid port: ' + split_host_port.port_s);
  console.log('Using parameters ' + JSON.stringify({localAddress, localPort}, null, '    '));

  net.createServer(tunnel => {
    const tag = `[Tunnel~[${tunnel.remoteAddress}]:${tunnel.remotePort}] `;
    console.log(`${tag}Connected from [${tunnel.remoteAddress}]:${tunnel.remotePort}`);

    tunnelUtil.init_mux_tunnel(tunnel, tag, /*isTunnelServer:*/true);

  }).listen({host: localAddress, port: localPort}, function () {
    console.log(`Listening at [${this.address().address}]:${this.address().port}`);
  }).on('error', e => console.log('' + e));
}

function split_host_port(combo) {
  let m = combo.match(/^(\d+)$|^\[([^\]]*)\]:?(.*)$|^([^:]*):([^:]*)$|^(.*)$/);
  return [(m[2] || m[4] || m[6] || '').replace(/^\*$/, ''), (split_host_port.port_s = (m[1] || m[3] || m[5] || '')) & 0xffff];
}

main(process.argv.slice(2));  //script args is start from the 3rd.
