import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data', 'attributes');
const appearancePath = join(root, 'appearance.json');
const wardrobePath = join(root, 'wardrobe.json');
const outputPath = join(root, 'wardrobe-expansion.json');
const appearance = JSON.parse(readFileSync(appearancePath, 'utf8'));
const wardrobe = JSON.parse(readFileSync(wardrobePath, 'utf8'));

// Compact source for the generated, checked-in data. Each theme expands into a balanced
// twenty-piece capsule. The nouns are deliberately style-specific; the shared construction
// only supplies colour/material variations and keeps every capsule's slot coverage identical.
const themes = [
  ['classical_roman','Classical Greco-Roman','historical','ivory|madder red','linen|fine wool','draped tunic|short stola blouse','wrapped peplos skirt|belted linen trousers','draped stola|one-shoulder banquet gown','palla wrap|hooded travel mantle','woven calf wraps','leather sandals|gold strap sandals','laurel hair ribbon|embroidered sash','coin pendant|serpent armlet','linen breast band','linen briefs','sheer banquet wrap','mosaic-trim bathing tunic'],
  ['medieval_commoner','Medieval commoner','historical','oatmeal|forest green','linen|rough wool','lace-neck chemise|fitted wool bodice','ankle wool skirt|practical drawstring breeches','simple kirtle|festival overdress','wool hood|weathered cloak','wool hose','turnshoes|mud-ready ankle boots','woven belt pouch|linen coif','wooden bead necklace|small iron brooch','linen breast band','drawstring linen briefs','soft sleeping chemise','river-bathing shift'],
  ['medieval_court','Medieval courtly','historical','wine red|royal blue','silk|velvet','embroidered undergown top|fitted brocade bodice','panelled court skirt|silk riding trousers','jewel-neck court gown|long-sleeved houppelande','ermine-trim mantle|velvet travelling cloak','silk clocked hose','soft leather slippers|embroidered riding boots','pearl veil|jewelled girdle','sapphire pendant|filigree brooch','silk breast band','fine linen briefs','sheer silk chamber robe','embroidered bathing shift'],
  ['renaissance_style','Renaissance','historical','burgundy|saffron','brocade|linen','square-neck bodice|billowed chemise','split overskirt|velvet breeches','slashed-sleeve gown|merchant-princess dress','fur-edged capelet|damask cloak','embroidered stockings','corded slippers|lace-up boots','feathered cap|ornate girdle','cameo pendant|pearl drop earrings','corded linen stays','ribbon-tied drawers','lace chamber gown','lagoon bathing chemise'],
  ['victorian_style','Victorian','historical','plum|bottle green','taffeta|lace','high-neck blouse|puffed-sleeve bodice','bustled walking skirt|tailored riding trousers','button-front day dress|off-shoulder evening gown','fitted riding jacket|velvet opera cape','seamed stockings','button boots|satin evening slippers','lace gloves|ribbon bonnet','mourning locket|cameo brooch','boned cotton corset','lace-trim drawers','sheer peignoir','striped bathing dress'],
  ['edo_wafuku','Edo-period wafuku','historical','indigo|persimmon','silk|hemp linen','wrap-front kosode top|short haori blouse','pleated hakama|layered wrap skirt','seasonal-flower kimono|formal furisode','patterned haori|rain cape','white tabi socks','zori sandals|lacquered geta','silk obi|folding fan','kanzashi hair ornament|jade netsuke pendant','sarashi chest wrap','linen fundoshi briefs','light sleeping yukata','river-bathing yukata'],
  ['jazz_age','Jazz Age flapper','historical','champagne|midnight blue','silk|beaded chiffon','dropped-waist camisole|art-deco halter top','pleated dance skirt|wide-leg lounge trousers','beaded flapper dress|backless jazz-club gown','cocoon coat|fringed evening wrap','rolled silk stockings','T-strap heels|buttoned walking shoes','feather headband|beaded evening bag','long pearl strand|art-deco cuff','silk bandeau bra','tap pants','fringed chiffon teddy','striped seaside playsuit'],
  ['disco_seventies','Seventies disco','historical','copper|electric purple','lamé|stretch jersey','halter-neck disco top|sequinned wrap blouse','high-waist flares|metallic hot pants','shimmer wrap dress|deep-V dance gown','faux-fur jacket|satin bomber','sparkle knee socks','platform sandals|white go-go boots','wide metallic belt|tinted aviators','oversized hoop earrings|layered chain necklace','metallic triangle bra','high-cut briefs','plunging lamé bodysuit','rainbow stripe bikini'],
  ['high_fantasy_court','High-fantasy courtly','fantasy','moon silver|emerald','velvet|enchanted silk','jewel-collar court bodice|rune-embroidered blouse','flowing court skirt|fitted riding trousers','star-thread court gown|open-back elven gown','fur-lined royal mantle|silverleaf cape','patterned silk hose','jewelled slippers|silver riding boots','crystal crown|embroidered sash','moonstone pendant|leafwork ear cuffs','silk ribbon bra','embroidered briefs','sheer enchanted robe','pearlscale bathing set'],
  ['fantasy_adventurer','Fantasy adventurer','fantasy','weathered brown|moss green','leather|linen','lace-front adventurer shirt|reinforced sleeveless tunic','pocketed trail trousers|split riding skirt','belted travel dress|tavern festival dress','hooded field cloak|patched leather jerkin','wool boot socks','knee-high travel boots|soft camp shoes','map belt pouch|fingerless gloves','compass pendant|carved token bracelet','linen wrap bra','drawstring briefs','soft camp chemise','waterfall bathing wrap'],
  ['armoured_warrior','Armoured warrior','fantasy','steel grey|crimson','chainmail|quilted linen','padded arming top|chainmail crop hauberk','reinforced battle skirt|armoured trousers','ceremonial armour dress|shieldmaiden tunic dress','pauldron mantle|fur battle cloak','armoured greaves','plated battle boots|soft barracks boots','sword belt|leather bracers','house-sigil pendant|victory torc','quilted support bra','linen battle briefs','strapped leather harness set','training-pool wrap'],
  ['arcane_mage','Arcane mage','fantasy','amethyst|ink blue','velvet|sheer silk','star-chart blouse|high-collar rune top','flowing scholar skirt|pocketed spell trousers','constellation robe dress|slit ritual gown','wide-sleeve mage robe|hooded astral cape','rune-knit stockings','soft spell slippers|buckled scholar boots','component belt|pointed velvet hat','crystal focus pendant|orbiting charm bracelet','silk triangle bra','rune-trim briefs','sheer ritual bodysuit','moonlit bathing wrap'],
  ['druidic_nature','Druidic nature','fantasy','fern green|bark brown','woven linen|soft leather','leaf-laced halter|moss embroidered tunic','petal-layer skirt|vine-belt trousers','wildflower drape dress|open-back grove gown','living-leaf mantle|weatherproof bark cloak','vine-pattern leg wraps','soft hide boots|barefoot anklet sandals','herb satchel|antler hair comb','acorn pendant|woven twig cuff','woven wrap bra','leaf-soft briefs','vine-laced body wrap','lily-pad bathing set'],
  ['celestial_divine','Celestial divine','fantasy','cloud white|sun gold','gossamer|silk','halo-neck draped top|gold-thread wrap blouse','floating panel skirt|white silk trousers','radiant column gown|open-back winged dress','featherlight mantle|sunburst cape','gold-thread stockings','winged sandals|pearl slippers','halo circlet|white opera gloves','sun medallion|starfall earrings','white silk bralette','gold-trim briefs','gossamer body veil','sunlit pearl bikini'],
  ['infernal_demonic','Infernal demonic','fantasy','ember red|obsidian','leather|smoked silk','horn-buckle corset top|flame-cut halter','spiked mini skirt|fitted infernal trousers','ember-slit gown|black contract dress','smoke cape|spiked leather coat','flame-pattern thigh highs','cloven platform boots|black stiletto boots','tail-chain belt|horn jewellery cuffs','obsidian choker|ruby claw ring','strappy red bra','black cut-out briefs','chain-detailed bodysuit','lava-shimmer bikini'],
  ['aquatic_seafolk','Aquatic sea-folk','fantasy','seafoam|pearl pink','iridescent silk|netted linen','shell-bead halter|scale shimmer wrap top','pearl fringe skirt|flowing tide trousers','foam-layer dress|deep-sea slit gown','kelp-weave shawl|iridescent rain cape','pearl ankle strands','shell sandals|translucent water shoes','shell crown|netted hip scarf','pearl collar|coral cuff','shell-cup bra','scale-shimmer briefs','pearl-chain body drape','iridescent fin bikini'],
  ['shadow_rogue','Shadow rogue','fantasy','charcoal|deep violet','soft leather|matte linen','cross-laced stealth top|hooded fitted tunic','hidden-pocket trousers|split stealth skirt','disguise-ready wrap dress|midnight tavern dress','many-pocket cloak|silent leather jacket','dark calf wraps','silent sole boots|soft climbing shoes','lockpick belt|half-mask scarf','black coin pendant|thin blade hairpin','matte wrap bra','hidden-pocket briefs','strapped shadow bodysuit','black river suit'],
  ['classic_supersuit','Classic supersuit','hero','primary red|electric blue','technical stretch|metallic weave','emblem supersuit top|armoured crop top','high-waist hero leggings|panelled flight skirt','cape-backed hero suit|ceremonial victory dress','detachable hero cape|weatherproof patrol jacket','reinforced hero tights','aerodynamic boots|off-duty logo sneakers','identity mask|utility belt','emblem pendant|power-dampening cuff','support supersuit bra','seamless hero briefs','one-piece mission suit','hydrodynamic rescue suit'],
  ['tactical_vigilante','Tactical vigilante','hero','matte black|gunmetal','armoured textile|leather','high-neck tactical top|reinforced compression shirt','utility combat trousers|armoured moto leggings','concealed-armour dress|zip-front stealth suit','hooded patrol coat|armoured biker jacket','cut-resistant tights','silent patrol boots|grip-soled trainers','half mask|modular utility belt','tracker pendant|black metal cuff','compression sports bra','seamless black briefs','strapped tactical bodysuit','black dive suit'],
  ['supervillain_couture','Supervillain couture','hero','poison green|imperial purple','latex|velvet','dramatic high-collar top|cut-out power corset','sculpted pencil skirt|cape-panel trousers','throne-room gown|asymmetric latex dress','floor-length villain cape|sharp-shoulder coat','seamed shimmer tights','metallic thigh boots|razor-point heels','opera gloves|jeweled eye mask','statement collar|signet claw ring','structured plunge bra','cut-out high waist briefs','architectural latex bodysuit','metallic villain swimsuit'],
  ['magical_heroine','Magical heroine','hero','rose pink|sky blue','satin|sparkle tulle','bow-front transformation top|crystal sailor blouse','pleated battle skirt|ribbon-trim shorts','transformation dress|star-layer party gown','short ribbon cape|pastel varsity jacket','star-print thigh highs','knee-high magic boots|heart buckle shoes','transformation brooch|elbow gloves','star choker|crystal charm bracelet','bow satin bra','ruffled briefs','ribbon-laced bodysuit','sparkle sailor swimsuit'],
  ['retro_pulp_hero','Retro pulp hero','hero','scarlet|cream','satin|sturdy cotton','emblem halter top|buttoned adventure blouse','high-waist hero shorts|jodhpur trousers','pulp heroine dress|cape-shoulder cocktail dress','short dramatic cape|double-breasted flight jacket','sheer back-seam tights','knee hero boots|lace-up pilot shoes','domino mask|wide emblem belt','deco hero pin|victory cuff','bullet-cup satin bra','high-waist briefs','satin playsuit','striped rescue swimsuit'],
  ['sleek_futurist','Sleek futurist','futurist','optic white|liquid silver','smart fabric|bonded mesh','seamless asymmetry top|light-reactive collar shirt','sculpted smart trousers|floating panel skirt','minimal lightline dress|adaptive column gown','temperature-control coat|transparent rain shell','gradient compression tights','magnetic sole boots|seamless slip shoes','hologram visor|modular waist band','lightline collar|gesture-control cuff','seamless smart bra','bonded briefs','adaptive mesh bodysuit','self-drying swim shell'],
  ['spacefaring','Spacefaring','futurist','navy|safety orange','flight nylon|thermal knit','station henley|pressure-suit underlayer','cargo flight trousers|zero-g utility shorts','zip flight dress|formal command uniform dress','mission flight jacket|insulated station coat','thermal flight socks','magnetic deck boots|soft cabin shoes','mission harness|transparent helmet collar','orbit token pendant|ship-ID wristband','compression support bra','thermal briefs','zero-g sleep suit','pressure-rated swim suit'],
  ['alien_couture','Alien couture','futurist','ultraviolet|opal green','biofabric|translucent membrane','living sculptural top|asymmetric membrane blouse','floating tendril skirt|jointed biofabric trousers','bioluminescent sheath dress|gravity-defying gala gown','responsive mantle|translucent cocoon coat','glowing lattice legwear','morphing platform shoes|soft membrane boots','sensory crown|living waist tendril','pulse-light collar|orbiting ear jewels','adaptive biofabric bra','seamless membrane briefs','living second-skin suit','colour-shifting swim skin'],
  ['post_apocalyptic','Post-apocalyptic scavenger','futurist','dust tan|rust red','salvaged canvas|patched leather','repaired thermal top|strapped scavenger vest','reinforced cargo trousers|patched utility skirt','converted parachute dress|armoured road dress','dust hood coat|salvaged moto jacket','wrapped dust gaiters','reinforced road boots|repaired combat shoes','filter scarf|salvage utility belt','found-metal pendant|wire-wrapped cuff','patched support bra','soft salvaged briefs','strap-built survival bodysuit','reservoir bathing wrap'],
  ['space_cowgirl','Space cowgirl','futurist','desert tan|starlight blue','brushed suede|flight nylon','pearl-snap flight shirt|star-stitched western top','high-rise trail jeans|fringed zero-g skirt','belted saloon dress|star-map slip dress','shearling flight vest|dusty range coat','patterned boot socks','gravity boots|silver-toe cowboy boots','constellation hatband|tooled utility holster','turquoise pendant|meteorite ring','front-clasp flight bra','star-print briefs','fringed midnight teddy','starlight halter bikini'],
  ['regency_noir','Regency noir','historical','black tea|antique gold','silk taffeta|fine wool','high-collar walking blouse|empire-waist bodice','ink riding skirt|tailored evening trousers','black empire gown|gold-trim ballroom dress','spencer jacket|hooded opera cloak','ribboned silk stockings','button ankle boots|satin ballroom slippers','mourning gloves|silk reticule','signet locket|jet drop earrings','corded silk stays','ribbon-tied drawers','sheer candlelit peignoir','striped seaside bathing dress'],
  ['dark_fairy','Dark fairy','fantasy','midnight plum|poison green','sheer organza|soft leather','thorn-laced blouse|moonlit halter top','layered petal skirt|fitted moss trousers','moonflower gown|slit twilight dress','wing-slit velvet cape|cobweb shawl','shimmer vine tights','leaf-heeled boots|moonstone slippers','crystal vial belt|thorned hair comb','moth-wing pendant|black pearl cuff','ribboned bralette','petal-cut briefs','cobweb lace bodysuit','lily-black bathing wrap'],
  ['mecha_pilot','Mecha pilot','hero','warning orange|slate grey','flight nylon|armoured mesh','zip-neck pilot top|emblem compression shirt','reinforced cockpit trousers|panelled utility skirt','command-uniform dress|off-duty hangar dress','squadron bomber|armoured flight coat','pressure-knit tights','magnetic deck boots|lace-up flight shoes','neural-link visor|flight harness','squadron tag|control-interface cuff','compression flight bra','seamless pilot briefs','mesh under-suit','training-bay swimsuit'],
];

const families = {
  historical: 'Historical and period', fantasy: 'Fantasy world', hero: 'Hero and villain suits', futurist: 'Futurist and spacefaring',
};
const counts = { top:[4,7], bottom:[2,4], dress:[1,3], outer:[1,3], legwear:[1,3], shoes:[2,4], extras:[1,3], jewellery:[1,4], bra:[1,2], panties:[1,3], lingerie:[0,2], swim:[0,2] };
const fields = ['id','label','family','colours','materials','tops','bottoms','dresses','outers','legwear','shoes','extras','jewellery','bra','panties','lingerie','swim'];
const styleDefs = themes.map((raw) => Object.fromEntries(fields.map((key, i) => [key, raw[i]])));
const split = (s) => s.split('|');
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const row = (id, category, label, prompt_hint, extra, rarity='uncommon') => ({ id, category, label, weight:1, rarity, prompt_hint, image_prompt:null, affinities:[], conflicts:[], modifies:{}, extra, enabled:true });

const expansion = [];
for (const [id, label] of Object.entries(families)) expansion.push(row(id, 'wardrobe_family', label, '', { counts }, 'common'));
for (const s of styleDefs) {
  expansion.push(row(s.id, 'clothing_style', s.label, `dresses in a committed ${s.label.toLowerCase()} wardrobe rather than a modern approximation`, { wardrobe_families:[s.family], photo_scene:`a setting that belongs naturally to her ${s.label.toLowerCase()} life` }));
  const colours=split(s.colours), materials=split(s.materials);
  const topNames = split(s.tops);
  const specs = [
    ['top',...topNames,`${materials[1]} ${topNames[0]}`], ['bottom',...split(s.bottoms)], ['dress',...split(s.dresses)], ['outer',...split(s.outers)],
    ['legwear',s.legwear], ['shoes',...split(s.shoes)], ['extras',...split(s.extras)], ['jewellery',...split(s.jewellery)],
    ['bra',s.bra], ['panties',s.panties], ['lingerie',s.lingerie], ['swim',s.swim],
  ];
  let n=0;
  for (const [slot, ...names] of specs) for (const name of names) {
    const tint = n % 3 === 0 && !name.toLowerCase().includes(colours[0]) ? `${colours[n % colours.length]} ` : '';
    const label = `${tint}${name}`;
    const extra = { slot, families:[s.family], styles:[s.id] };
    if (slot === 'swim') extra.pieces = { lingerie: label.toLowerCase() };
    expansion.push(row(`${s.id}_${slug(name)}`, 'wardrobe_item', label[0].toUpperCase()+label.slice(1), label.toLowerCase(), extra, 'common'));
    n++;
  }
  if (n !== 20) throw new Error(`${s.id} generated ${n}, expected 20`);
}

const anatomyItems = [
  ['wing_split_halter','Back-split halter top','top','wing_opening'], ['wing_tie_back_blouse','Tie-back blouse with a wing opening','top','wing_opening'],
  ['wing_backless_wrap_dress','Backless wrap dress cut around wings','dress','wing_opening'], ['wing_slit_evening_dress','Evening dress with tailored wing slits','dress','wing_opening'],
  ['wing_split_cape','Shoulder-fastened split cape','outer','wing_opening'], ['wing_friendly_shawl','Soft shawl worn clear of her wings','outer','wing_opening'],
  ['tail_split_trousers','Tailored trousers with a reinforced tail opening','bottom','tail_opening'], ['tail_port_skirt','High-waist skirt with a discreet tail port','bottom','tail_opening'],
  ['tail_slit_dress','Fitted dress tailored around her tail','dress','tail_opening'], ['tail_friendly_briefs','Soft briefs with a comfortable tail opening','panties','tail_opening'],
  ['horn_wrap_headband','Wrap headband fitted between her horns','extras','horn_friendly'], ['horn_open_crown_hat','Open-crown hat shaped around her horns','extras','horn_friendly'],
  ['horn_chain_jewellery','Fine decorative chains draped between her horns','jewellery','horn_friendly'], ['horn_side_fastened_hood','Side-fastened hood that clears her horns','outer','horn_friendly'],
  ['soft_hoof_wraps','Soft protective hoof wraps','shoes','hoof_friendly'], ['fitted_hoof_guards','Fitted leather hoof guards','shoes','hoof_friendly'],
  ['hoof_ankle_wraps','Decorative ankle wraps above her hooves','legwear','hoof_friendly'],
];
for (const [id,label,slot,adaptation] of anatomyItems) expansion.push(row(id,'wardrobe_item',label,label.toLowerCase(),{slot,families:[],adaptations:[adaptation]},'common'));

const speciesAdaptations = {
  fairy:['wing_opening'], angel:['wing_opening'], harpy:['wing_opening'], mothgirl:['wing_opening'],
  catgirl:['tail_opening'], doggirl:['tail_opening'], foxgirl:['tail_opening'], succubus:['tail_opening','horn_friendly'], tiefling:['tail_opening','horn_friendly'],
  dragonkin:['tail_opening','horn_friendly'], bunnygirl:['tail_opening'], wolfgirl:['tail_opening'], kitsune:['tail_opening'], sharkgirl:['tail_opening'],
  cowgirl:['tail_opening','horn_friendly'], lizardfolk:['tail_opening'], kobold:['tail_opening','horn_friendly'], tanuki:['tail_opening'], satyr:['horn_friendly','hoof_friendly'], oni:['horn_friendly'],
};
const speciesStyleWeights = {
  elf:{high_fantasy_court:3,druidic_nature:1.8}, vampire:{victorian_style:2.5,goth_girl:1.8}, fairy:{fairycore:2.5,druidic_nature:2}, alien:{alien_couture:3,spacefaring:1.5},
  dragonkin:{armoured_warrior:2,high_fantasy_court:1.8}, dryad:{druidic_nature:4}, angel:{celestial_divine:4,angelcore:2}, android:{sleek_futurist:3},
  valkyrie:{armoured_warrior:4}, genie:{high_fantasy_court:2.2}, satyr:{druidic_nature:2.5}, golem:{armoured_warrior:1.8}, frostfae:{celestial_divine:2},
  umbra:{shadow_rogue:3}, minor_goddess:{celestial_divine:3}, contract_demon:{infernal_demonic:4}, amazon:{armoured_warrior:4}, cyborg:{sleek_futurist:2.5,tactical_vigilante:1.5},
  nymph:{druidic_nature:3.5}, mothgirl:{fairycore:1.8}, slimegirl:{alien_couture:1.8}, kobold:{fantasy_adventurer:2.5},
};

const layerStyleWeights = {
  roaring_twenties:{jazz_age:4}, victorian:{victorian_style:4}, seventies:{disco_seventies:4}, medieval:{medieval_commoner:3,medieval_court:2},
  ancient_rome:{classical_roman:5}, edo_japan:{edo_wafuku:5}, far_future:{sleek_futurist:3,spacefaring:2,alien_couture:1.5,post_apocalyptic:1.5},
  fantasy_world:{high_fantasy_court:2.5,fantasy_adventurer:2.5,armoured_warrior:2,arcane_mage:2,druidic_nature:1.8,shadow_rogue:1.8},
  public_hero:{classic_supersuit:4,retro_pulp_hero:1.6}, secret_identity:{classic_supersuit:2,tactical_vigilante:1.6}, vigilante:{tactical_vigilante:5},
  reformed_villain:{supervillain_couture:4}, off_duty_villain:{supervillain_couture:5}, retired_hero:{classic_supersuit:2},
  hero_for_hire:{tactical_vigilante:3,classic_supersuit:1.5}, rookie_hero:{magical_heroine:2.5,classic_supersuit:2},
};
for (const id of new Set([...Object.keys(speciesAdaptations),...Object.keys(speciesStyleWeights)])) {
  expansion.push(row(`species_${id}`,'wardrobe_lean',`Wardrobe fit for ${id.replaceAll('_',' ')}`,'',{source_category:'species',source_id:id,adaptations:speciesAdaptations[id]??[],weights:speciesStyleWeights[id]??{}},'common'));
}
for (const [id,weights] of Object.entries(layerStyleWeights)) {
  const source_category = appearance.some((r)=>r.category==='species'&&r.id===id) ? 'species' : (id.includes('hero')||['secret_identity','vigilante','reformed_villain','off_duty_villain'].includes(id) ? 'hero_role' : 'era');
  expansion.push(row(`${source_category}_${id}`,'wardrobe_lean',`Wardrobe lean for ${id.replaceAll('_',' ')}`,'',{source_category,source_id:id,adaptations:[],weights},'common'));
}

// Curate a deterministic 24-piece capsule for every pre-existing style. Semantic matches win;
// the stable hash only breaks ties, so family siblings no longer receive identical closets.
const existingStyles = appearance.filter((r) => r.category === 'clothing_style');
const existingItems = wardrobe.filter((r) => r.category === 'wardrobe_item' && r.extra?.slot !== 'work');
for (const item of existingItems) delete item.extra.styles;
const stop = new Set(['style','girl','full','wear','wears','only','ever','and','with','the','for','look','looks','like','clothing','deliberately','purpose','whole']);
const hash = (s) => { let h=2166136261; for (const c of s) h=Math.imul(h^c.charCodeAt(0),16777619); return h>>>0; };
const slotTargets = { top:3, bottom:2, dress:2, outer:2, legwear:2, shoes:2, extras:2, jewellery:2, swim:1 };
for (const style of existingStyles) {
  const fams = new Set(style.extra?.wardrobe_families ?? ['basics']);
  const words = `${style.id} ${style.label} ${style.prompt_hint}`.toLowerCase().match(/[a-z]{3,}/g)?.filter((w) => !stop.has(w)) ?? [];
  // Universal basics remain available to every closet through their family, but they are not
  // claimed as the signature capsule of ninety unrelated aesthetics. Provenance stays on the
  // more characteristic family pieces.
  const candidates = existingItems.filter((it) => (it.extra?.families ?? []).some((f) => f !== 'any' && fams.has(f)));
  const score = (it) => {
    const text = `${it.id} ${it.label} ${it.prompt_hint}`.toLowerCase();
    return words.reduce((sum,w) => sum + (text.includes(w) ? 100 : 0), 0) + (hash(`${style.id}:${it.id}`)%100)/100;
  };
  const picked=[];
  for (const [slot, target] of Object.entries(slotTargets)) picked.push(...candidates.filter((i)=>i.extra.slot===slot).sort((a,b)=>score(b)-score(a)).slice(0,target));
  for (const it of candidates.sort((a,b)=>score(b)-score(a))) if (picked.length<24 && !picked.includes(it)) picked.push(it);
  if (picked.length<20) throw new Error(`${style.id} has only ${picked.length} capsule items`);
  for (const it of picked.slice(0,24)) it.extra.styles=[...(it.extra.styles??[]),style.id];
}

writeFileSync(wardrobePath, `${JSON.stringify(wardrobe, null, 2)}\n`);
writeFileSync(outputPath, `${JSON.stringify(expansion, null, 2)}\n`);
console.log(`Wrote ${styleDefs.length} styles and ${expansion.filter((r)=>r.category==='wardrobe_item').length} items; curated ${existingStyles.length} existing style capsules.`);
