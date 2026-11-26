import vm from 'node:vm';
import { readSource, extractTopLevel } from './render-test-kit.mjs';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };

function startHost(...args) {
  const context = {
    net: {}, player: {}, NET_SHIRTS: ['red'], ROOM_CODE: 'PABCDE', playerName: 'Ann', gameMinutes: 10,
    document: { body: { classList: { add() {} } } },
    clamp: (value, low, high) => Math.min(high, Math.max(low, value)),
    netServerUrl: () => 'ws://localhost',
    netDial: () => {},
  };
  vm.runInNewContext(extractTopLevel(readSource('net.js'), 'netStartHost') + '\nnetStartHost(...args);', Object.assign(context, { args }));
  return context.net;
}

console.log('1) public game');
let net = startHost('', 4, true, () => {}, { title: 'Roma', isPublic: true });
ok(net.hello.t === 'create' && net.hello.title === 'Roma' && net.hello.public === true, 'title and public sent');
ok(net.hello.pass === '', 'no password');

console.log('2) private game');
net = startHost('secret', 4, true, () => {}, { title: 'Casa', isPublic: false });
ok(net.hello.public === false && net.hello.title === 'Casa' && net.hello.pass === 'secret', 'private with password');

console.log('3) options omitted');
net = startHost('', 4, true, () => {});
ok(net.hello.public === false && net.hello.title === '', 'private, empty title');
ok(net.rejoin.code === 'PABCDE' && net.rejoin.name === 'Ann', 'rejoin unchanged');

console.log(`\n${fail ? '❌' : '✅'}  ${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
