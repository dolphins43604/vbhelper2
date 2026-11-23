// Copies Plotly (finance build) into www/vendor so the app works offline.
import { mkdirSync, copyFileSync } from 'node:fs';
mkdirSync('www/vendor', { recursive: true });
copyFileSync('node_modules/plotly.js-finance-dist-min/plotly-finance.min.js', 'www/vendor/plotly-finance.min.js');
console.log('vendor: plotly-finance.min.js copied');
