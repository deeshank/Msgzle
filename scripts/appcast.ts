import {readFileSync,writeFileSync,statSync} from 'node:fs';
const version=process.env.MSGZLE_RELEASE_VERSION??JSON.parse(readFileSync('package.json','utf8')).version;if(!/^\d+\.\d+\.\d+$/.test(version))throw Error('Invalid version');const build=Number(process.env.MSGZLE_BUILD_NUMBER??1);if(!Number.isSafeInteger(build)||build<1)throw Error('Invalid build');
const arch=process.argv[2];if(!['arm64','x64'].includes(arch))throw Error('Invalid arch');
const signature=readFileSync('build/signature.txt','utf8').match(/sparkle:edSignature="([A-Za-z0-9+/=]+)"/);
if(!signature)throw Error('No valid Sparkle signature');
const length=statSync(`build/Msgzle-${arch}.zip`).size;
writeFileSync(`build/appcast-${arch}.xml`,`<?xml version="1.0" encoding="utf-8"?><rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><title>Msgzle</title><item><title>Msgzle ${version}</title><sparkle:version>${build}</sparkle:version><sparkle:shortVersionString>${version}</sparkle:shortVersionString><sparkle:minimumSystemVersion>13.0</sparkle:minimumSystemVersion><enclosure url="https://github.com/deeshank/Msgzle/releases/download/v${version}/Msgzle-${arch}.zip" sparkle:edSignature="${signature[1]}" length="${length}" type="application/octet-stream" /></item></channel></rss>`);
