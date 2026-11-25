#!/bin/sh
# End-to-end smoke test of the bundled command-line tool on synthetic beeps
# (5 × 0.55 s at 4 kHz, one per second, twice). Usage: sh cli/smoke.sh (from web/)
set -eu
ASD="node $(pwd)/dist/cli/asd.mjs"
T="$(mktemp -d)"
cd "$T"
node -e '
const SR=16000,n=30*SR,b=Buffer.alloc(44+n*2);let s=1;const r=()=>((s=(s*1103515245+12345)&0x7fffffff)/0x7fffffff)-0.5;
b.write("RIFF",0);b.writeUInt32LE(36+n*2,4);b.write("WAVE",8);b.write("fmt ",12);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);
b.writeUInt32LE(SR,24);b.writeUInt32LE(SR*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write("data",36);b.writeUInt32LE(n*2,40);
const on=[3,4,5,6,7,20,21,22,23,24];
for(let i=0;i<n;i++){let v=r()*600;const t=i/SR;for(const o of on)if(t>=o&&t<o+0.55)v+=8000*Math.sin(2*Math.PI*4000*t);b.writeInt16LE(Math.round(v),44+i*2);}
require("fs").writeFileSync("beeps.wav",b);'
$ASD events beeps.wav --group A --labels-out labels.json --json > events.json
grep -q '"count": 10' events.json
$ASD tune --labels labels.json --out p.json --name "Test beeper" --json > tune.json
grep -q '"verdict": "good"' tune.json
$ASD test --preset p.json --labels labels.json --json > test.json
grep -q '"missed": \[\]' test.json
$ASD validate p.json
$ASD device --file device.json --name smoke-test > /dev/null
$ASD yaml --device device.json --preset p.json --out final.yaml
$ASD yaml --device device.json --recording --out rec.yaml
grep -q 'name: "Test beeper alarm"' final.yaml
grep -q 'capture_server:' rec.yaml
echo "asd smoke test OK ($T)"
