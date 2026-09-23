"""Component-browser tests with a loopback API bridge when browser navigation is unavailable.
Requires Python + Playwright + Chromium and a running `npm start`.
This is NOT an end-to-end test of cookies, CSP, CORS, HTTPS, or deployed navigation.
Application modules and CSS are loaded unchanged except module bundling. Only transport,
UUID fallback and window.location's URL base are supplied by the test harness.
"""
import json, os, re, time
from pathlib import Path
from urllib.request import build_opener, HTTPCookieProcessor, Request
from urllib.error import HTTPError
from http.cookiejar import CookieJar
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'reports';OUT.mkdir(exist_ok=True)
PREV=ROOT/'previews';PREV.mkdir(exist_ok=True)
BASE=os.environ.get('EKT_TEST_URL','http://127.0.0.1:3000')
results=[]

def bridge_factory():
    client=build_opener(HTTPCookieProcessor(CookieJar()))
    def bridge(path, options):
        if not path.startswith('/api/') or '..' in path: raise ValueError('Only this demo API')
        payload=options.get('body')
        req=Request(BASE+path,data=payload.encode() if payload else None,headers=options.get('headers',{}),method=options.get('method','GET'))
        try: response=client.open(req,timeout=15)
        except HTTPError as e: response=e
        return {'status':response.status,'headers':dict(response.headers.items()),'data':json.loads(response.read())}
    return bridge

def module(name, exports, prefix=''):
    code=(ROOT/'public'/name).read_text()
    code=re.sub(r'^import .*?;\n','',code,flags=re.M)
    code=re.sub(r'^export ','',code,flags=re.M)
    return f"const {{{', '.join(exports)}}} = (() => {{\n{prefix}\n{code}\nreturn {{{', '.join(exports)}}};\n}})();\n"

BUNDLE='''(() => {
const window = new Proxy(globalThis.window, {get(t,k) {
  if (k === 'location') return {href: 'https://component.invalid/' + t.location.hash, origin: 'https://component.invalid'};
  const value = Reflect.get(t,k); return typeof value === 'function' ? value.bind(t) : value;
}});
const crypto = {randomUUID: () => {
 const b=globalThis.crypto.getRandomValues(new Uint8Array(16)); b[6]=(b[6]&15)|64; b[8]=(b[8]&63)|128;
 const h=Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}};
const fetch = async (path, options={}) => { let r; try { r=await globalThis.__api_bridge(path, options); } catch(e) { console.error('BRIDGE', String(e)); throw e; } return {status:r.status,ok:r.status>=200&&r.status<300,headers:new Headers(r.headers),json:async()=>r.data}; };
'''
BUNDLE+=module('api.js',['api','requestId','safeLink'])
BUNDLE+=module('evidence.js',['escapeHTML','evidenceHTML','comparisonHTML'])
BUNDLE+=module('revisor.js',['createRevisor'],'const esc = escapeHTML;')
BUNDLE+=re.sub(r'^import .*?;\n','',(ROOT/'public/app.js').read_text(),flags=re.M)
BUNDLE+='\n})();'
HTML=(ROOT/'public/index.html').read_text()
HTML=re.sub(r'<script[^>]*>.*?</script>','',HTML,flags=re.S)
HTML=re.sub(r'<link[^>]*>','',HTML)

def record(name,condition):
    results.append({'name':name,'passed':bool(condition)})
    if not condition: raise AssertionError(name)

with sync_playwright() as pw:
    browser=pw.chromium.launch(headless=True,executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),args=['--no-sandbox'])
    page=browser.new_page(viewport={'width':1440,'height':1000},device_scale_factor=1)
    errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    page.expose_function('__api_bridge',bridge_factory())
    page.set_content(HTML);page.add_style_tag(content=(ROOT/'public/styles.css').read_text());page.add_script_tag(content=BUNDLE)
    page.wait_for_selector('#audit-submit:not([disabled])',timeout=10000)
    record('initial screen has no fabricated test passes', page.locator('.check-row').count()==0)
    page.click('#audit-submit');page.wait_for_selector('.audit-row')
    record('audit shows four rows and one ready item',page.locator('.audit-row').count()==4 and page.locator('#selected-count').inner_text()=='1 из 4 строк')
    page.locator('.audit-row .evidence summary').first.click()
    record('source, fetched_at and demo mode visible',all(x in page.locator('.audit-row .evidence').first.inner_text() for x in ['fetched_at','demo:catalog','data_mode']))
    page.evaluate('scrollTo(0,0)');page.wait_for_timeout(100)
    page.screenshot(path=str(PREV/'revisor-desktop.png'),full_page=True)
    # Compare known parameter mismatch and unknown dimensions.
    page.locator('.audit-alternatives>summary').click()
    record('analogue comparison visibly exposes C/B and missing dimensions',page.locator('.verdict.different').count()>0 and page.locator('.verdict.unknown').count()>0)
    record('incompatible candidate has no selection button',page.locator('[data-product-id="demo-005"]').count()==0)
    page.locator('[data-product-id="demo-001"]').click()
    record('replacement is explicitly selected and marked unconfirmed', 'Вы выбрали DEMO-001' in page.locator('#audit-results').inner_text())
    # Editing invalidates the previous audit.
    page.fill('#audit-input','DEMO-001 ; 2 шт.\nDEMO-003 ; 10 м')
    record('edited input invalidates prior choices',page.locator('.audit-row').count()==0)
    page.click('#audit-submit');page.wait_for_selector('.audit-row')
    page.click('#prepare-list');page.wait_for_selector('#confirm-proposal:not([disabled])')
    record('batch proposal lists exact two items without premature success',page.locator('.proposal-product').count()==2 and page.locator('[data-cart-count]').first.inner_text()=='0')
    page.fill('#message-input','да, но не добавляй');page.click('#send-button')
    page.wait_for_function("!document.querySelector('#message-input').disabled")
    record('negative confirmation leaves cart empty',page.locator('[data-cart-count]').first.inner_text()=='0' and page.locator('#confirm-proposal').count()==1)
    page.fill('#message-input','да, добавь');page.click('#send-button')
    page.wait_for_selector('#confirm-proposal',state='detached')
    record('explicit typed confirmation waits for server and adds both lines',page.locator('[data-cart-count]').first.inner_text()=='2')
    page.evaluate("location.hash='#cart'");page.wait_for_selector('.cart-item')
    record('cart displays two items and server total',page.locator('.cart-item').count()==2 and '12' in page.locator('.summary-total').inner_text())
    page.screenshot(path=str(PREV/'revisor-cart.png'),full_page=True)
    page.evaluate("location.hash='#checks'")
    page.click('[data-suite="core"]');page.wait_for_selector('.check-row',timeout=15000)
    record('live UI displays actual twelve-test report',page.locator('.check-row').count()==12 and '12 из 12' in page.locator('#check-results h2').inner_text())
    record('test execution did not change customer cart',page.locator('[data-cart-count]').first.inner_text()=='2')
    page.evaluate('scrollTo(0,0)');page.wait_for_timeout(100)
    page.screenshot(path=str(PREV/'revisor-checks.png'),full_page=True)
    page.wait_for_timeout(1100);page.click('[data-suite="repeat"]');page.wait_for_selector('.proof-banner')
    record('five-request proof displays one write', '5 подтверждений → 1 запись' in page.locator('.proof-banner').inner_text())
    page.wait_for_timeout(1100);page.click('[data-suite="refusal"]');page.wait_for_selector('.proof-banner.refusal')
    record('refusal proof exposes HTTP 409', 'HTTP 409' in page.locator('.proof-banner').inner_text())
    record('successful cart mutation invalidates previous audit',page.locator('.audit-row').count()==0)
    page.evaluate("location.hash='#audit'");page.click('#load-example');page.click('#audit-submit');page.wait_for_selector('.audit-row')
    page.wait_for_timeout(6200)
    for width in [390,320]:
        page.set_viewport_size({'width':width,'height':844})
        for screen in ['audit','chat','cart','checks']:
            page.evaluate(f"location.hash='#{screen}'");page.wait_for_timeout(650 if screen=='cart' else 80)
            overflow=page.evaluate('document.documentElement.scrollWidth > window.innerWidth + 1')
            record(f'no page overflow at {width}px: {screen}',not overflow)
        page.evaluate("location.hash='#audit'")
        if width==390:
            page.evaluate('scrollTo(0,0)');page.wait_for_timeout(100)
            page.screenshot(path=str(PREV/'revisor-mobile.png'),full_page=True)
    record('no uncaught JavaScript errors',not errors)
    browser.close()
report={'transport':'in-memory browser modules + loopback HTTP bridge; not deployed E2E','tested_at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'checks':results,'summary':{'total':len(results),'passed':sum(r['passed'] for r in results)},'limitations':['Browser navigation to URLs is unavailable in this environment. Cookies/CSP/CORS/HTTPS and actual link navigation were not exercised by the component browser harness.','Real direct HTTP state/CSRF/Origin checks are in npm test.']}
(OUT/'browser-components.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps(report['summary']))
