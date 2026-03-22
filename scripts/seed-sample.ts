/**
 * Seed the NKSC database with sample guidance documents, advisories, and
 * frameworks for testing.
 *
 * Usage:
 *   npx tsx scripts/seed-sample.ts
 *   npx tsx scripts/seed-sample.ts --force
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

const DB_PATH = process.env["NKSC_DB_PATH"] ?? "data/nksc.db";
const force = process.argv.includes("--force");

const dir = dirname(DB_PATH);
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
if (force && existsSync(DB_PATH)) { unlinkSync(DB_PATH); console.log(`Deleted existing database at ${DB_PATH}`); }

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(SCHEMA_SQL);
console.log(`Database initialised at ${DB_PATH}`);

const frameworks = [
  { id: "nksc", name: "NKSC Gairės ir rekomendacijos", name_en: "NKSC Guidelines and Recommendations", description: "Oficialios NKSC gairės ir techninės rekomendacijos informacinių sistemų apsaugai, incidentų valdymui ir kibernetiniam saugumui.", document_count: 20 },
  { id: "rrt", name: "RRT — Kibernetinio saugumo rekomendacijos", name_en: "RRT — Cybersecurity Recommendations", description: "Ryšių reguliavimo tarnybos (RRT) rekomendacijos elektroninių ryšių tinklų ir paslaugų saugumui.", document_count: 11 },
  { id: "nis2", name: "NIS2 — Nacionalinis įgyvendinimas", name_en: "NIS2 — National Implementation", description: "Direktyvos (ES) 2022/2555 (NIS2) įgyvendinimo Lietuvoje medžiaga.", document_count: 10 },
];

const ins = db.prepare("INSERT OR IGNORE INTO frameworks (id, name, name_en, description, document_count) VALUES (?, ?, ?, ?, ?)");
for (const f of frameworks) ins.run(f.id, f.name, f.name_en, f.description, f.document_count);
console.log(`Inserted ${frameworks.length} frameworks`);

const guidance = [
  { reference: "NKSC-G-2023-001", title: "Kibernetinių incidentų valdymo gairės", title_en: "Cybersecurity Incident Management Guidelines", date: "2023-05-08", type: "guideline", series: "NKSC", summary: "Gairės aprašo kibernetinių incidentų identifikavimo, klasifikavimo, reagavimo ir pranešimo procedūras esminių ir svarbių paslaugų operatoriams.", full_text: "NKSC skelbia šias incidentų valdymo gaires pagal Kibernetinio saugumo įstatymą ir NIS2 direktyvą. Incidentai klasifikuojami pagal svarbą nuo 1 (maža) iki 4 (kritinė). Esminių paslaugų operatoriai privalo pranešti apie reikšmingus incidentus NKSC per 24 valandas (išankstinis perspėjimas) ir per 72 valandas (pilna ataskaita). NKSC koordinuoja reagavimą į didelio masto incidentus su nacionalinėmis institucijomis ir tarptautinėmis CERT organizacijomis.", topics: JSON.stringify(["incident_response", "reporting", "NIS2"]), status: "current" },
  { reference: "NKSC-G-2023-003", title: "Techninės tinklo saugumo gairės", title_en: "Technical Network Security Guidelines", date: "2023-08-14", type: "guideline", series: "NKSC", summary: "Techninės gairės saugaus tinklo infrastruktūros projektavimui ir valdymui valstybinėse institucijose ir ypatingos svarbos infrastruktūros operatoriuose.", full_text: "NKSC skelbia technines tinklo saugumo gaires. Reikalavimai: tinklo segmentavimas pagal saugumo zonas; tinklo srauto stebėjimas naudojant IDS/IPS sistemas; prisijungimų valdymas per centralizuotą IAM sistemą; TLS 1.2 ar naujesnės versijos naudojimas; reguliarūs pažeidžiamumų skenavimai; incidentų žurnalų saugojimas mažiausiai 12 mėnesių.", topics: JSON.stringify(["network_security", "IDS", "access_control", "TLS"]), status: "current" },
  { reference: "NKSC-G-2022-008", title: "Ypatingos svarbos informacinės infrastruktūros apsaugos gairės", title_en: "Critical Information Infrastructure Protection Guidelines", date: "2022-10-05", type: "guideline", series: "NKSC", summary: "Gairės kritinės informacinės infrastruktūros identifikavimui ir apsaugai energetikos, transporto ir finansų sektoriuose.", full_text: "NKSC skelbia gaires ypatingos svarbos informacinės infrastruktūros apsaugai. Minimalūs reikalavimai: visų IT turto registras; metinis rizikos vertinimas; OT tinklų atskyrimas nuo korporatyvinių tinklų; kasdieninis kritinių duomenų atsarginis kopijavimas su kopija ne pagrindinėje vietoje; išbandytas veiklos tęstinumo planas su RTO ne daugiau kaip 24 valandoms.", topics: JSON.stringify(["critical_infrastructure", "risk_management", "OT_security"]), status: "current" },
  { reference: "RRT-R-2023-002", title: "Elektroninių ryšių tinklų saugumo rekomendacijos", title_en: "Recommendations for Electronic Communications Network Security", date: "2023-06-20", type: "recommendation", series: "RRT", summary: "RRT rekomendacijos elektroninių ryšių tinklų ir paslaugų operatoriams dėl saugumo reikalavimų pagal Elektroninių ryšių įstatymą.", full_text: "RRT skelbia rekomendacijas elektroninių ryšių tinklų saugumui. Operatoriai privalo įgyvendinti proporcingus technines ir organizacines priemones tinklo ir paslaugų saugumui užtikrinti. Reikalavimai: reguliarus saugumo rizikos vertinimas; incidentų pranešimo sistema; kriptografinė tinklo srauto apsauga; dvifaktoris autentifikavimas administravimo sąsajoms.", topics: JSON.stringify(["network_security", "telecom", "risk_management"]), status: "current" },
  { reference: "NIS2-LT-2024-001", title: "NIS2 reikalavimų įgyvendinimo Lietuvoje vadovas", title_en: "Guide for Implementation of NIS2 Requirements in Lithuania", date: "2024-03-01", type: "guideline", series: "NIS2", summary: "Praktinis vadovas esminių ir svarbių paslaugų operatoriams Lietuvoje NIS2 direktyvos reikalavimams įgyvendinti.", full_text: "NKSC skelbia NIS2 direktyvos įgyvendinimo Lietuvoje vadovą. Operatoriai turi užsiregistruoti iki 2025 m. balandžio mėn. Prievolės: rizikos valdymas; tiekimo grandinės saugumo vertinimas; išankstinis perspėjimas per 24 valandas, pilna ataskaita per 72 valandas. Sankcijos už pažeidimus: iki 10 000 000 eurų arba 2% metinės apyvartos esminių paslaugų operatoriams.", topics: JSON.stringify(["NIS2", "risk_management", "incident_reporting"]), status: "current" },
];

const ig = db.prepare("INSERT OR IGNORE INTO guidance (reference, title, title_en, date, type, series, summary, full_text, topics, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
db.transaction(() => { for (const g of guidance) ig.run(g.reference, g.title, g.title_en, g.date, g.type, g.series, g.summary, g.full_text, g.topics, g.status); })();
console.log(`Inserted ${guidance.length} guidance documents`);

const advisories = [
  { reference: "NKSC-A-2024-002", title: "Kritinė pažeidžiamybė Fortinet FortiOS VPN", date: "2024-02-08", severity: "critical", affected_products: JSON.stringify(["Fortinet FortiOS 7.4.x", "Fortinet FortiOS 7.2.x", "FortiGate"]), summary: "NKSC perspėja apie aktyviai išnaudojamą kritinę pažeidžiamybę CVE-2024-21762 Fortinet FortiOS, leidžiančią vykdyti kodą be autentifikavimo.", full_text: "NKSC užfiksavo aktyvų CVE-2024-21762 pažeidžiamybės išnaudojimą Fortinet FortiOS sistemose. Pažeidžiamybė leidžia neautentifikuotam užpuolikui nuotoliniu būdu vykdyti kodą. Rekomendacijos: nedelsiant atnaujinkite FortiOS iki pataisytos versijos; patikrinkite sistemos žurnalus dėl kompromitavimo požymių; apribokite prieigą prie administravimo sąsajų.", cve_references: JSON.stringify(["CVE-2024-21762"]) },
  { reference: "NKSC-A-2024-005", title: "Padidėjusi DDoS atakų grėsmė prieš lietuviškas organizacijas", date: "2024-05-15", severity: "high", affected_products: JSON.stringify(["Web servers", "DNS infrastructure", "Financial services platforms"]), summary: "NKSC fiksuoja padidėjusią DDoS atakų, nukreiptų prieš lietuviškas organizacijas, aktyvumą. Atakos susijusios su geopolitiniais įvykiais.", full_text: "NKSC fiksuoja padidėjusią distributuotų paslaugų trikdymo (DDoS) atakų bangą prieš Lietuvos viešojo ir privataus sektoriaus organizacijas. Atakos naudoja amplifikacijos metodus per DNS ir NTP protokolus. Rekomendacijos: aktivuokite DDoS apsaugos paslaugas; konfigūruokite spartinimo ribojimus prie tinklo ribų; koordinuokite su interneto paslaugų teikėjais. Didelės rizikos sektoriai: finansai, transportas, energetika.", cve_references: JSON.stringify([]) },
  { reference: "NKSC-A-2023-018", title: "Pažeidžiamybė MOVEit Transfer programinėje įrangoje", date: "2023-06-02", severity: "critical", affected_products: JSON.stringify(["Progress MOVEit Transfer", "MOVEit Cloud"]), summary: "NKSC skelbia skubų perspėjimą dėl kritinės SQL injekcijos pažeidžiamybės CVE-2023-34362 MOVEit Transfer programinėje įrangoje.", full_text: "NKSC perspėja apie aktyviai išnaudojamą CVE-2023-34362 SQL injekcijos pažeidžiamybę MOVEit Transfer programinėje įrangoje. Pažeidžiamybė leidžia neautentifikuotiems vartotojams gauti prieigą prie duomenų bazės. Cl0p ransomware grupė masiškai išnaudoja šią pažeidžiamybę. Rekomendacijos: nedelsiant atjunkite MOVEit Transfer nuo interneto; patikrinkite sistemos žurnalus; įdiekite pataisymą ir patikrinkite vartotojų paskyras.", cve_references: JSON.stringify(["CVE-2023-34362"]) },
];

const ia = db.prepare("INSERT OR IGNORE INTO advisories (reference, title, date, severity, affected_products, summary, full_text, cve_references) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
db.transaction(() => { for (const a of advisories) ia.run(a.reference, a.title, a.date, a.severity, a.affected_products, a.summary, a.full_text, a.cve_references); })();
console.log(`Inserted ${advisories.length} advisories`);

const gCount = (db.prepare("SELECT count(*) as cnt FROM guidance").get() as { cnt: number }).cnt;
const aCount = (db.prepare("SELECT count(*) as cnt FROM advisories").get() as { cnt: number }).cnt;
const fCount = (db.prepare("SELECT count(*) as cnt FROM frameworks").get() as { cnt: number }).cnt;
console.log(`\nDatabase summary:\n  Frameworks: ${fCount}\n  Guidance:   ${gCount}\n  Advisories: ${aCount}\n\nDone. Database ready at ${DB_PATH}`);
db.close();
