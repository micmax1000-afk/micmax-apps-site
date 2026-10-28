// Aggiorna le addizionali regionali IRPEF dai file ufficiali del Ministero dell'economia e delle finanze,
// per l'app Turni & Accessorio PS. Gira da solo una volta al mese (GitHub Actions) e scrive in
// turni/tabelle.json regioniAddizionaleAnni (anno scorso e anno in corso) e regioniAddizionale (anno in corso).
// Le regole scritte solo a parole nelle delibere regionali (esenzioni, aliquota unica sotto una soglia,
// detrazioni) stanno in turni/addizionali-regole.json: se una delibera nuova ha un testo mai visto,
// lo script lo scrive in .github/da-controllare.md e il workflow apre una segnalazione.
// Uso: node .github/scripts/aggiorna-addizionali.mjs [--cartella-csv percorso]  (con i file già scaricati)
import fs from 'node:fs';
import crypto from 'node:crypto';

const URL_REG = 'https://www1.finanze.gov.it/finanze2/dipartimentopolitichefiscali/fiscalitalocale/addregirpef/download/download.php?tipo=reg&anno=';
const FILE_TABELLE = 'turni/tabelle.json';
const FILE_REGOLE = 'turni/addizionali-regole.json';
const FILE_CONTROLLO = '.github/da-controllare.md';

const arg = process.argv.indexOf('--cartella-csv');
const cartellaLocale = arg > 0 ? process.argv[arg + 1] : null;
const oggi = new Date();
const ANNO = oggi.getUTCFullYear();

const REGIONI = {
  "ABRUZZO": 'Abruzzo', "BASILICATA": 'Basilicata', "CALABRIA": 'Calabria', "CAMPANIA": 'Campania',
  "EMILIA-ROMAGNA": 'Emilia-Romagna', "EMILIA ROMAGNA": 'Emilia-Romagna', "FRIULI VENEZIA GIULIA": 'Friuli Venezia Giulia', "FRIULI-VENEZIA GIULIA": 'Friuli Venezia Giulia',
  "LAZIO": 'Lazio', "LIGURIA": 'Liguria', "LOMBARDIA": 'Lombardia', "MARCHE": 'Marche', "MOLISE": 'Molise', "PIEMONTE": 'Piemonte',
  "PROVINCIA AUTONOMA DI BOLZANO": 'Provincia di Bolzano', "PROVINCIA AUTONOMA DI TRENTO": 'Provincia di Trento',
  "PUGLIA": 'Puglia', "SARDEGNA": 'Sardegna', "SICILIA": 'Sicilia', "TOSCANA": 'Toscana', "UMBRIA": 'Umbria',
  "VALLE D'AOSTA": "Valle d'Aosta", "VENETO": 'Veneto'
};
const TUTTE = [...new Set(Object.values(REGIONI))];

async function scarica(url, nomeLocale, codifica){
  let buf;
  if(cartellaLocale){
    const p = `${cartellaLocale}/${nomeLocale}`;
    if(!fs.existsSync(p)) return null;
    buf = fs.readFileSync(p);
  } else {
    try{
      const r = await fetch(url, { headers: { 'User-Agent': 'micmax-apps-site (aggiornamento addizionali)' } });
      if(!r.ok) return null;
      buf = Buffer.from(await r.arrayBuffer());
    }catch(e){ console.log(`Non scaricato: ${url} (${e.cause ? e.cause.code || e.cause.message : e.message})`); return null; }
    if(/<html/i.test(buf.subarray(0, 300).toString('latin1'))) return null;
  }
  return new TextDecoder(codifica).decode(buf);
}

// CSV con ";" e campi tra virgolette.
function leggiCsv(testo){
  const righe = []; let campo = '', riga = [], q = false;
  for(let i = 0; i < testo.length; i++){
    const c = testo[i];
    if(q){ if(c === '"'){ if(testo[i + 1] === '"'){ campo += '"'; i++; } else q = false; } else campo += c; }
    else if(c === '"') q = true;
    else if(c === ';'){ riga.push(campo); campo = ''; }
    else if(c === '\n'){ riga.push(campo.replace(/\r$/, '')); righe.push(riga); riga = []; campo = ''; }
    else campo += c;
  }
  if(campo || riga.length){ riga.push(campo); righe.push(riga); }
  const intest = righe.shift().map(h => h.trim());
  return righe.filter(r => r.length > 1).map(r => Object.fromEntries(intest.map((h, i) => [h, (r[i] || '').trim()])));
}

// "15.000,00" → 15000 · "15000.00" → 15000 · ",8" → 0.8
function numero(s){
  s = String(s).trim().replace(/[€\s]/g, '');
  if(!s) return NaN;
  if(s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if(/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  else if(/^\d{1,3}(\.\d{3})+\.\d{1,2}$/.test(s)) s = s.replace(/\.(?=\d{3}\b)/g, '');   // "15.000.00"

  return Number(s);
}
const numeriNelTesto = t => (String(t).match(/\d[\d.]*(,\d+)?|,\d+/g) || []).map(numero).filter(n => isFinite(n));

// Tetto di uno scaglione dal testo: null = "oltre" (ultimo scaglione).
function tettoScaglione(testo){
  const t = String(testo).toLowerCase();
  const n = numeriNelTesto(t).filter(x => x >= 100);
  if(!n.length) return undefined;
  if(n.length === 1 && /oltre|superiori|maggiori/.test(t) && !/fino|\ba\b|sino/.test(t.replace(/applicabile a/, ''))) return null;
  return n[n.length - 1];
}

function hash(s){ return crypto.createHash('sha1').update(s).digest('hex').slice(0, 12); }

// ── Regionali ────────────────────────────────────────────────────────────────────
function regionaliDaCsv(righe, anno, regole, daControllare){
  const perRegione = {};
  for(const r of righe){
    const nome = REGIONI[r.REGIONE.replace(/^REGIONE\s+/i, '').trim().toUpperCase()];
    if(!nome) continue;
    (perRegione[nome] = perRegione[nome] || []).push(r);
  }
  const out = {};
  for(const [nome, tutte] of Object.entries(perRegione)){
    // Vale l'ultima delibera pubblicata (numero più alto).
    const ultimo = Math.max(...tutte.map(r => Number(r.NUMERO) || 0));
    const righe = tutte.filter(r => (Number(r.NUMERO) || 0) === ultimo);
    let d;
    if(righe.length === 1 && /unica/i.test(righe[0]['FASCIA'] || '')) d = { tipo: 'unica', valore: numero(righe[0].ALIQUOTA) };
    else {
      const sc = righe.map(r => ({ fino: tettoScaglione(r['FASCIA']), aliquota: numero(r.ALIQUOTA) }))
        .filter(s => s.fino !== undefined && isFinite(s.aliquota))
        .sort((a, b) => (a.fino === null ? Infinity : a.fino) - (b.fino === null ? Infinity : b.fino));
      if(!sc.length || sc[sc.length - 1].fino !== null) throw new Error(`Scaglioni non leggibili: ${nome} ${anno}`);
      d = { tipo: 'scaglioni', scaglioni: sc };
    }
    Object.assign(d, (regole[anno] || {})[nome] || {});
    out[nome] = d;
    const testo = `${righe[0].DISPOSIZIONE || ''} ${righe[0].NOTE || ''}`.trim();
    const chiave = `${anno}|${nome}|${ultimo}|${hash(testo)}`;
    if(testo && !(regole.controllati || []).includes(chiave)) daControllare.push({ chiave, anno, nome, numero: ultimo, data: righe[0]['DATA PUBBLICAZIONE'], testo });
  }
  return out;
}

const versioneOggi = () => `${oggi.getUTCFullYear()}.${oggi.getUTCMonth() + 1}.${oggi.getUTCDate()}`;
const dataOggi = () => oggi.toISOString().slice(0, 10);
const scrivi = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 1) + '\n');

const regole = JSON.parse(fs.readFileSync(FILE_REGOLE, 'utf8'));
const tabelle = JSON.parse(fs.readFileSync(FILE_TABELLE, 'utf8'));
const daControllare = [], resoconto = [];

const anniReg = { ...(tabelle.tabelle.regioniAddizionaleAnni || {}) };
for(const anno of [ANNO - 1, ANNO, ANNO + 1]){
  const reg = await scarica(URL_REG + anno, `addreg${anno}.csv`, 'latin1');
  if(reg){
    const r = regionaliDaCsv(leggiCsv(reg), anno, regole, daControllare);
    const mancano = TUTTE.filter(n => !r[n]);
    if(mancano.length && anno <= ANNO) resoconto.push(`Regionali ${anno}: mancano ${mancano.join(', ')} (restano i valori di prima)`);
    if(Object.keys(r).length >= 15 || anniReg[anno]) anniReg[anno] = { ...(anniReg[anno] || {}), ...r };
  } else if(anno <= ANNO) resoconto.push(`Regionali ${anno}: file non scaricato (restano i valori di prima)`);
}
// Si tengono solo gli ultimi tre anni.
for(const o of [anniReg]) Object.keys(o).filter(a => Number(a) < ANNO - 2).forEach(a => delete o[a]);

// Tabelle: si cambia la versione solo se le addizionali sono davvero cambiate.
const primaReg = JSON.stringify(tabelle.tabelle.regioniAddizionaleAnni || {});
if(JSON.stringify(anniReg) !== primaReg){
  tabelle.tabelle.regioniAddizionaleAnni = anniReg;
  if(anniReg[ANNO]) tabelle.tabelle.regioniAddizionale = anniReg[ANNO];
  tabelle.versione = versioneOggi();
  tabelle.aggiornato = dataOggi();
  tabelle.nota = 'Addizionali regionali aggiornate dal Ministero dell’economia e delle finanze';
  scrivi(FILE_TABELLE, tabelle);
  resoconto.push(`Tabelle: addizionali regionali aggiornate, versione ${tabelle.versione}`);
}
if(daControllare.length){
  fs.writeFileSync(FILE_CONTROLLO, `Delibere regionali nuove da leggere: se cambiano esenzioni, aliquote uniche o detrazioni, aggiornare ${FILE_REGOLE} e aggiungere la chiave a "controllati".\n\n` +
    daControllare.map(d => `### ${d.nome} — ${d.anno} (delibera ${d.numero}, ${d.data})\nChiave: \`${d.chiave}\`\n\n${d.testo}\n`).join('\n'));
}
console.log(resoconto.length ? resoconto.join('\n') : 'Nessun cambiamento.');
