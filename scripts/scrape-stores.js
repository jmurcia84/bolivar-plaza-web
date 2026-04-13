/**
 * scrape-stores.js
 * Scrapes store data from ccbolivarplaza.com/tiendas using Puppeteer.
 *
 * Page structure discovered:
 *  .cuadro.cursor              — each store card
 *    img.w_full                — logo image (path contains nivel{N} = floor)
 *    div.descp
 *      p:first-child           — "Local: {number}"
 *      a.nom                   — store name
 *      a.wsp[href]             — WhatsApp link (https://wa.me/{number})
 *      a.insta[href]           — Instagram URL
 *      a.face[href]            — Facebook URL
 *      a.twit[href]            — Twitter/X URL
 */

import puppeteer from 'puppeteer';
import { createWriteStream, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import slugify from 'slugify';
import https from 'https';
import http from 'http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT       = join(__dirname, '..');
const LOGOS_DIR  = join(ROOT, 'public', 'uploads', 'logos');
const STORES_DIR = join(ROOT, 'src', 'content', 'stores');

mkdirSync(LOGOS_DIR,  { recursive: true });
mkdirSync(STORES_DIR, { recursive: true });

const BASE_URL = 'https://www.ccbolivarplaza.com';

function toSlug(name) {
  return slugify(name, { lower: true, strict: true, locale: 'es' });
}

function mapCategory(raw) {
  if (!raw) return 'Otros';
  const r = raw.toLowerCase();
  if (r.includes('vestuario') || r.includes('moda') || r.includes('ropa') || r.includes('calzado') || r.includes('jeans') || r.includes('accesorios')) return 'Moda';
  if (r.includes('gastronom') || r.includes('café') || r.includes('cafe') || r.includes('restaurante') || r.includes('comida') || r.includes('food') || r.includes('pizza') || r.includes('burger') || r.includes('siete') || r.includes('qbano') || r.includes('ristretto') || r.includes('mcdonald')) return 'Comidas';
  if (r.includes('cine') || r.includes('entretenimiento') || r.includes('juego') || r.includes('diversi') || r.includes('royal') || r.includes('play')) return 'Entretenimiento';
  if (r.includes('salud') || r.includes('belleza') || r.includes('bienestar') || r.includes('farmacia') || r.includes('droguería') || r.includes('spa') || r.includes('optica') || r.includes('óptica') || r.includes('peluquería') || r.includes('cruz verde') || r.includes('essence')) return 'Salud y Belleza';
  if (r.includes('telecom') || r.includes('celular') || r.includes('electr') || r.includes('tecnología') || r.includes('digital') || r.includes('computo')) return 'Tecnología';
  if (r.includes('hogar') || r.includes('decoración') || r.includes('mueble')) return 'Hogar';
  if (r.includes('servicio') || r.includes('banco') || r.includes('financiero') || r.includes('apostas') || r.includes('apostar') || r.includes('lotería')) return 'Servicios';
  return 'Otros';
}

function mapFloor(nivel) {
  if (!nivel) return 'Piso 1';
  const n = String(nivel);
  if (n.includes('4')) return 'Piso 4';
  if (n.includes('3')) return 'Piso 3';
  if (n.includes('2')) return 'Piso 2';
  return 'Piso 1';
}

function mapFloorFromLocal(local) {
  if (!local) return 'Piso 1';
  const match = local.match(/^(\d)/);
  if (!match) return 'Piso 1';
  return `Piso ${match[1]}`;
}

async function downloadImage(url, destPath) {
  if (!url) return false;
  const fullUrl = url.startsWith('http') ? url : `${BASE_URL}${url}`;
  // Resolve ../ in URL path
  const cleanUrl = fullUrl.replace('/php/../', '/');

  return new Promise((resolve) => {
    try {
      const protocol = cleanUrl.startsWith('https') ? https : http;
      const file = createWriteStream(destPath);
      const req = protocol.get(cleanUrl, { timeout: 12000 }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          file.close();
          const loc = res.headers.location;
          downloadImage(loc?.startsWith('http') ? loc : `${BASE_URL}${loc}`, destPath).then(resolve);
          return;
        }
        if (res.statusCode !== 200) { file.close(); resolve(false); return; }
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(true); });
      });
      req.on('error', () => { file.close(); resolve(false); });
      req.on('timeout', () => { req.destroy(); file.close(); resolve(false); });
    } catch { resolve(false); }
  });
}

function writeStoreFile(store) {
  const slug = toSlug(store.name);
  const filePath = join(STORES_DIR, `${slug}.md`);
  const esc = (s) => (s || '').replace(/"/g, '\\"');
  const content = `---
name: "${esc(store.name)}"
category: "${store.category}"
floor: "${store.floor}"
local: "${esc(store.local)}"
description: ""
logo: "${store.logo}"
facebook: "${esc(store.facebook)}"
instagram: "${esc(store.instagram)}"
twitter_x: "${esc(store.twitter_x)}"
whatsapp: "${esc(store.whatsapp)}"
active: true
---
`;
  writeFileSync(filePath, content, 'utf8');
  return slug;
}

async function scrape() {
  console.log('🚀 Launching browser…');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1280, height: 900 });

  console.log('🌐 Fetching https://www.ccbolivarplaza.com/tiendas …');
  try {
    await page.goto(`${BASE_URL}/tiendas`, { waitUntil: 'networkidle2', timeout: 30000 });
  } catch {
    console.log('⚠️  networkidle2 timed out, using what loaded…');
  }
  await new Promise(r => setTimeout(r, 3000));

  // Scroll to trigger lazy loading
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await new Promise(r => setTimeout(r, 2000));

  console.log('🔍 Extracting store data from .cuadro.cursor cards…');

  const rawStores = await page.evaluate((baseUrl) => {
    const cards = document.querySelectorAll('.cuadro.cursor');
    const stores = [];

    cards.forEach(card => {
      // Store name from a.nom
      const nameEl = card.querySelector('a.nom, .nom');
      const name = nameEl?.innerText?.trim() || nameEl?.textContent?.trim() || '';
      if (!name || name.length < 2) return;

      // Logo image
      const img = card.querySelector('img.w_full, img');
      const imgSrc = img?.getAttribute('src') || img?.src || '';
      const fullImgUrl = imgSrc.startsWith('http') ? imgSrc : `${baseUrl}${imgSrc}`;

      // Extract floor from image path (nivel1, nivel2, nivel3, nivel4)
      const nivelMatch = imgSrc.match(/nivel(\d)/);
      const nivel = nivelMatch ? nivelMatch[1] : '1';

      // Local number from first <p> in .descp
      const descp = card.querySelector('.descp, [class*="descp"]');
      const localP = descp?.querySelector('p');
      const localRaw = localP?.innerText?.trim() || localP?.textContent?.trim() || '';
      const local = localRaw.replace(/^local:\s*/i, '').trim();

      // Social links
      const wspEl = card.querySelector('a.wsp, a[class*="wsp"]');
      const igEl  = card.querySelector('a.insta, a[class*="insta"]');
      const fbEl  = card.querySelector('a.face, a[class*="face"]');
      const twEl  = card.querySelector('a.twit, a[class*="twit"]');

      // WhatsApp: extract number from wa.me URL
      const wspHref = wspEl?.href || wspEl?.getAttribute('href') || '';
      const whatsapp = wspHref.replace('https://wa.me/', '').replace('http://wa.me/', '').split('?')[0].trim();

      const instagram = igEl?.href || igEl?.getAttribute('href') || '';
      const facebook  = fbEl?.href || fbEl?.getAttribute('href') || '';
      const twitter_x = twEl?.href || twEl?.getAttribute('href') || '';

      stores.push({ name, imgSrc: fullImgUrl, nivel, local, whatsapp, instagram, facebook, twitter_x });
    });

    return stores;
  }, BASE_URL);

  await browser.close();

  if (rawStores.length === 0) {
    console.log('❌ No stores found with .cuadro.cursor selector. Check the site structure.');
    process.exit(1);
  }

  console.log(`\n✅ Found ${rawStores.length} stores. Processing logos and writing content files…\n`);

  const results   = [];
  const failed    = [];

  for (const s of rawStores) {
    const slug = toSlug(s.name);
    if (!slug) continue;

    // Determine extension from URL
    const ext = s.imgSrc?.match(/\.(jpe?g|png|webp|svg)/i)?.[1]?.replace('jpeg','jpg') || 'jpg';
    const logoFilename  = `${slug}.${ext}`;
    const logoDestPath  = join(LOGOS_DIR, logoFilename);
    const logoPublicPath = `/uploads/logos/${logoFilename}`;

    let logo = '';
    if (s.imgSrc) {
      const ok = await downloadImage(s.imgSrc, logoDestPath);
      if (ok) {
        logo = logoPublicPath;
        process.stdout.write(`  ✓ ${s.name}\n`);
      } else {
        failed.push({ name: s.name, url: s.imgSrc });
        process.stdout.write(`  ✗ ${s.name} — logo failed\n`);
      }
    } else {
      process.stdout.write(`  – ${s.name} — no logo\n`);
    }

    // Determine floor: prefer nivel from img path, fallback to local number prefix
    const floor = s.nivel ? mapFloor(s.nivel) : mapFloorFromLocal(s.local);

    // Category from store name keyword matching
    const category = mapCategory(s.name);

    const store = {
      name: s.name,
      category,
      floor,
      local: s.local,
      logo,
      facebook:  s.facebook,
      instagram: s.instagram,
      twitter_x: s.twitter_x,
      whatsapp:  s.whatsapp,
    };

    writeStoreFile(store);
    results.push({ name: s.name, floor, local: s.local || '–', category });
  }

  // Summary
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(`  STORES SCRAPED: ${results.length}`);
  console.log('═══════════════════════════════════════════════════════════');
  results.forEach((r, i) => {
    const num = String(i + 1).padStart(2);
    const name = r.name.padEnd(32);
    const floor = r.floor.padEnd(8);
    const local = r.local.padEnd(12);
    console.log(`  ${num}. ${name} ${floor} Local: ${local} [${r.category}]`);
  });

  if (failed.length > 0) {
    console.log('\n  ⚠️  FAILED LOGO DOWNLOADS:');
    failed.forEach(f => console.log(`     ✗ ${f.name}: ${f.url}`));
  } else {
    console.log('\n  ✅ All logos downloaded successfully.');
  }

  console.log(`\n✅ Done — ${results.length} content files written to src/content/stores/\n`);
}

scrape().catch(err => { console.error('Fatal error:', err); process.exit(1); });
