const fs = require('fs');
const content = fs.readFileSync('src/components/MapView.tsx', 'utf8');
const match = content.match(/const LEAFLET_HTML = `([\s\S]*?)`;/);
if (match) {
  fs.writeFileSync('leaflet.html', match[1]);
  console.log('Saved to leaflet.html');
} else {
  console.log('Not found');
}
