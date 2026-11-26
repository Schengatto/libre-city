import fs from 'node:fs';
import path from 'node:path';

const html = fs.readFileSync(path.join(import.meta.dirname, '..', 'index.html'), 'utf8');
let pass = 0, fail = 0;
const ok = (condition, label) => { if (condition) { pass++; console.log('  ok  ' + label); } else { fail++; console.log('  FAIL ' + label); } };

const ruleBody = selector => {
  const start = html.indexOf('\n  ' + selector + ' {');
  return start < 0 ? '' : html.slice(start, html.indexOf('}', start));
};
const shortScreenBlock = html.slice(html.indexOf('@media (max-height:560px)'), html.indexOf('body.touch #start .keys.kb'));
const px = (body, property) => Number((body.match(new RegExp(`(?:^|[\\s;{])${property}:(\\d+)px`)) || [])[1]);
const paddingBottom = body => Number((body.match(/padding:\d+px \d+px (\d+)px/) || [])[1]);

console.log('1) fixed chrome hides the scrolling menu');
{
  const bandAlpha = Number((html.match(/--cabinet-band:rgba\(\d+,\d+,\d+,([\d.]+)\)/) || [])[1]);
  ok(bandAlpha >= 0.9, `cabinet band is near-opaque (alpha ${bandAlpha})`);
  ok(/#arcTop, #ticker, #start #credits \{ background:var\(--cabinet-band\)/.test(html), 'top bar, credits and ticker share the band background');
  ok(ruleBody('#musicBtn').includes('background:var(--cabinet-band)'), 'music toggle uses the band background');
  ok(!ruleBody('#ticker').includes('background:rgba'), 'ticker has no translucent override');
}

console.log('2) last line of a panel clears the bottom bands');
{
  const creditsBand = 30;
  const tickerHeight = px(ruleBody('#ticker'), 'height');
  const creditsBottom = px(ruleBody('#start #credits'), 'bottom');
  ok(creditsBottom === tickerHeight, `credits band sits on the ticker (${creditsBottom}px = ${tickerHeight}px)`);
  ok(paddingBottom(ruleBody('#start')) >= tickerHeight + creditsBand, 'default bottom padding covers ticker + credits');
  const shortTicker = px(shortScreenBlock, '#ticker \\{ height');
  const shortCreditsBottom = Number((shortScreenBlock.match(/#start #credits \{ bottom:(\d+)px/) || [])[1]);
  ok(shortCreditsBottom === shortTicker, `short screens: credits band sits on the ticker (${shortCreditsBottom}px = ${shortTicker}px)`);
  ok(paddingBottom(shortScreenBlock) >= shortTicker + creditsBand, 'short screens: bottom padding covers ticker + credits');
}

console.log(fail === 0 ? `\n✅  ${pass} ok, 0 fail` : `\n❌  ${pass} ok, ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
