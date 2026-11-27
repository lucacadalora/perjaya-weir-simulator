# Glossary (lane b03)

Fixed terms for every visible string. Indonesian first, English second. When you write a fallback in English, use the
English word here; lane b03 puts the Indonesian word in the table.

## House rules for Indonesian text
- Address the reader as "Anda". The team is "kami". Plain, short sentences, active voice, EYD spelling.
- Sentence case everywhere (titles, buttons, tabs). Capitals only for names: Bendung Perjaya, Sungai Komering.
- Decimal comma, thousands point: 2.200 m³/s, 81,00 m. Percent with no space: 12,5%.
- Dates: "4 Juni 2026". Ranges: "10 hingga 20", never a hyphen.
- No English left in the Indonesian table (no "debit inflow", no "update", no "loading").
- Modelled values are "model", never "terukur", "aktual", "real-time" or "langsung" (CONTRACT 2.1).
- Our structure is a "bendung", never "bendungan" (except once in the dossier, where the popular name is explained).
  A dam that the user builds in maker mode is a "bendungan".
- Proper names are not translated, in either language: Sungai Komering, Danau Ranau, Martapura, OKU Timur, Keromongan,
  Perjaya. Our own product name is translated: "Simulator Bendung Perjaya" / "Perjaya Weir Simulator".
- Tiga Dihaji: "sedang dibangun, belum digenangi" / "under construction, not yet filled" (never "rencana").
- English wording b03 sets apart from the code fallback lives in tools/i18n/en-overrides.json.

## The structure

| Indonesian | English | Note |
|---|---|---|
| bendung | weir | gated weir that raises the river to feed a canal |
| bendung gerak | gated weir | the type of Bendung Perjaya |
| bendungan | dam | a dam with a reservoir (maker mode) |
| bangunan utama | headworks | weir, intake and their parts together |
| mercu bendung | weir crest | |
| pintu | gate | |
| pintu banjir | flood gate | the seven 20 m gates |
| pintu pembilas | scouring sluice | flushes sediment at the intake |
| pembilas bawah | under-sluice | low opening under the scouring sluice |
| bukaan pintu | gate opening | in metres |
| P1…P7 / PB1…PB3 | FG1…FG7 / SG1…SG3 | gate and sluice numbers on drawings |
| pengambilan | intake | where the canal takes water |
| kantong lumpur | settling basin | settles silt after the intake (the data files say "settling basins") |
| tangga ikan | fish ladder | |
| kolam olak | stilling basin | |
| pelimpah | spillway | of a dam |
| pilar | pier | between gates |
| tembok pangkal | abutment | |
| tanggul | levee, embankment | |
| jembatan pelayanan | service bridge | |
| rumah pintu | gate house | |

## Water and levels

| Indonesian | English | Note |
|---|---|---|
| debit | flow, discharge | m³/s |
| debit model | modelled flow | never "debit terukur" |
| debit masuk | inflow | |
| debit keluar | outflow | |
| debit andalan | dependable flow | Q80: the flow reached 80% of the time |
| debit banjir | flood flow | |
| banjir rencana | design flood | the weir's own: "banjir rencana bendung 2.200 m³/s"; it has no return period, so never "banjir rencana kala ulang T tahun". Other floods: "banjir kala ulang {T} tahun" / "{T}-year flood" |
| muka air | water level | |
| muka air banjir | flood water level | |
| muka air banjir rencana (MAB) | design high water level (DHWL) | EL +81,00 m |
| muka air rencana | design water level | |
| muka air normal | normal water level | |
| elevasi | elevation, level | project levels: "EL +81,00 m"; maker-mode levels on the terrain: "m (medan model)" / "m (model terrain)" |
| hulu | upstream | |
| hilir | downstream | |
| tepi kiri / tepi kanan | left bank / right bank | looking downstream |
| genangan | inundation, flooded area | |
| kolam genangan | pond (above the weir) | |
| tampungan | storage | volume, m³ |
| waduk | reservoir | in maker-mode English text "lake" is allowed as the plain word |
| lengkung kapasitas | storage curve | level, area, volume |
| peluapan | overtopping | |
| sedimen | sediment | |
| kala ulang | return period | "kala ulang 100 tahun" |

## River basin and rain

| Indonesian | English | Note |
|---|---|---|
| daerah aliran sungai (DAS) | river basin | |
| daerah tangkapan air | catchment | |
| luas daerah tangkapan | catchment area | km² |
| anak sungai | tributary | |
| alur sungai | river channel | |
| dataran banjir | flood plain | |
| curah hujan | rainfall | mm |
| hujan harian | daily rain | |
| limpasan | runoff | |
| musim hujan | wet season | |
| musim kemarau | dry season | |
| penguapan | evaporation | |
| kekeringan | drought | |

## Irrigation

| Indonesian | English | Note |
|---|---|---|
| daerah irigasi (DI) | irrigation area | |
| saluran induk | main canal | |
| saluran sekunder | secondary canal | |
| jaringan irigasi | irrigation network | |
| kebutuhan air | water demand | |
| kebutuhan air irigasi | irrigation demand | l/s/ha or m³/s |
| pasokan air | water supply | |
| neraca air | water balance | |
| kekurangan air | water shortfall | |
| sawah | rice field | |
| musim tanam | cropping season | |
| pengolahan tanah | land preparation | |
| golongan | rotation group | |
| efisiensi irigasi | irrigation efficiency | |
| lahan | land | |

## Simulation and screen

| Indonesian | English | Note |
|---|---|---|
| simulasi | simulation | |
| skenario | scenario | |
| model indikatif | indicative model | "Model indikatif, bukan hasil survei" |
| operasi | operation | tab and gate operation |
| mode otomatis / mode manual | automatic / manual mode | |
| buat bendungan | build a dam | maker mode |
| dampak | impact | |
| survei dampak | impact survey | |
| bangunan terdampak | affected buildings | |
| tutupan lahan | land cover | |
| jalan / rel kereta | road / railway | |
| permukiman | settlement | |
| hutan, kebun, semak | forest, plantation, shrub | |
| peta | map | |
| tampilan 3D | 3D view | |
| rekam film | record a film | |
| gambar diam | still picture | |
| tautan berbagi | share link | |
| sumber | source | |
| status fakta | fact status | S, C, R, A, P |
| bersumber / dihitung / dibaca dari gambar / diasumsikan / berita | sourced / computed / read from a picture / assumed / press | the five status letters |
| dosir | dossier | |
| model permukaan 30 m | 30 m surface model | includes tree tops and roofs |
| jalankan / jeda / ulang | run / pause / reset | |
| kecepatan | speed | |
| per detik | per second | "1 hari per detik" |

## Units (same in both languages, Indonesian number style)
m³/s · m³ · juta m³ · miliar m³ · km² · ha · mm · m · km · l/s/ha · EL +81,00 m.
