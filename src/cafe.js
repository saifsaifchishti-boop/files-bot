/**
 * Caffy — the café menu + live "order tracker" for the bot.
 *  `.cafe` shows the menu, `.order 12` / `.order biryani` places an order, and the bot keeps EDITING one message
 *  through the kitchen stages (every item has its own funny lines). `.cafe off|admin|normal` controls who may use it.
 */
// [category, emoji, name, price, prep, cook, ride, joke]
const R = [
  ['DESI TADKA', '🍛', 'Chicken Biryani', 350, 'Chef is soaking the finest basmati rice', 'Dum is ON — the aroma just reached Lahore', 'Rider swears he did NOT touch the raita', 'Biryani is not food, it is an emotion'],
  ['DESI TADKA', '🍖', 'Mutton Karahi', 1400, 'Fresh mutton just met a very hot karahi', 'Tomatoes are surrendering to the flame', 'Rider is driving at 20 km/h to keep it hot', 'Warning: you will need 6 naans'],
  ['DESI TADKA', '🍗', 'Chicken Karahi', 1100, 'Chicken is taking a spicy bath', 'Ginger and green chillies are doing a dance', 'Rider is guarding the pot with his life', 'Rs 1100 well spent. No refunds on happiness'],
  ['DESI TADKA', '🥘', 'Nihari', 450, 'The nalli has been simmering since last night', 'Gravy is getting that royal brown colour', 'Rider balances the pot like a circus pro', 'Add lemon, ginger, fresh naan. Done'],
  ['DESI TADKA', '🍲', 'Haleem', 300, 'Daal and meat are becoming best friends', 'Chef is mashing it with serious muscle', 'Rider is racing before it cools down', 'Do not forget the fried onions on top'],
  ['DESI TADKA', '🍛', 'Chicken Handi', 900, 'Handi is on the stove, spices are queuing up', 'Cream just joined the party', 'Rider hugs the handi like a baby', 'Creamy, dreamy, and gone in 5 minutes'],
  ['DESI TADKA', '🍚', 'Daal Chawal', 220, 'Daal is getting its tadka ready', 'Garlic just sizzled — the kitchen is smiling', 'Rider says this is the most peaceful delivery', 'Simple food, rich soul'],
  ['DESI TADKA', '🫓', 'Aloo Paratha', 120, 'Aloo masala is stuffed with love', 'Desi ghee is dancing on the tawa', 'Rider: "Paratha is warm, so is my heart"', 'Pair it with chai and forget your worries'],
  ['DESI TADKA', '🥞', 'Halwa Puri', 280, 'Suji halwa is shining like gold', 'Pooris are puffing up like proud peacocks', 'Rider stopped twice to smell the box', 'Sunday breakfast, any day of the week'],
  ['DESI TADKA', '🥗', 'Chana Chaat', 150, 'Chickpeas just met tamarind chutney', 'Chef is sprinkling the magic chaat masala', 'Rider shakes the box — just kidding, he does not', 'Tangy, spicy, perfect'],
  ['FAST FOOD', '🍔', 'Zinger Burger', 380, 'Crispy chicken is being crowned', 'Fryer is singing at 180 degrees', 'Rider holds the burger higher than his phone', 'Open wide. Bigger. A little bigger'],
  ['FAST FOOD', '🍔', 'Beef Burger', 420, 'Patty is sizzling on the grill', 'Cheese is melting in slow motion', 'Rider is NOT sneaking a bite. Probably', 'Juicy enough to need 5 tissues'],
  ['FAST FOOD', '🥪', 'Club Sandwich', 350, 'Three layers of pure genius are stacking', 'Toast is turning golden brown', 'Rider uses both hands. Safety first', 'Cut in triangles because we are classy'],
  ['FAST FOOD', '🌯', 'Chicken Shawarma', 250, 'Chicken is rotating like a Bollywood hero', 'Garlic sauce is joining the roll', 'Rider speeds up as the sauce smell hits him', 'Extra garlic sauce = extra happiness'],
  ['FAST FOOD', '🍕', 'Fajita Pizza', 900, 'Dough is flying through the air', 'Cheese is bubbling in the oven', 'Rider drives flat to keep the cheese perfect', 'Fold it. Eat it. Repeat'],
  ['FAST FOOD', '🍝', 'Pasta Alfredo', 600, 'Water is boiling, pasta is diving in', 'White sauce is getting extra creamy', 'Rider tilts zero degrees. Pro driver', 'Twirl responsibly'],
  ['FAST FOOD', '🍟', 'Loaded Fries', 300, 'Fries are fresh, crispy and ready', 'Cheese sauce is raining on top', 'Rider: "These fries are watching me."', 'Not a snack, a lifestyle'],
  ['FAST FOOD', '🍗', 'Chicken Nuggets', 280, 'Nuggets are getting their golden jackets', 'Crunch level: maximum', 'Rider counts the nuggets. 12. Good', 'Dip. Crunch. Repeat'],
  ['FAST FOOD', '🌭', 'Hot Dog', 200, 'Bun is toasted, sausage is grilled', 'Mustard and ketchup are drawing lines', 'Rider says the hot dog is smiling', 'Nothing dogs here, only deliciousness'],
  ['FAST FOOD', '🌮', 'Wrap Roll', 260, 'Paratha is rolling, fillings are lining up', 'Sauce is drizzled in a perfect zig-zag', 'Rider keeps it upright like a trophy', 'Roll it. Hold it. Love it'],
  ['CHAI & COFFEE', '☕', 'Doodh Patti Chai', 80, 'Water and tea leaves are meeting', 'Milk joined, the chai is turning pink-brown', 'Rider is sipping the smell only', 'Chai is the answer to every problem'],
  ['CHAI & COFFEE', '🍵', 'Kashmiri Chai', 150, 'Pink tea is being whisked with patience', 'Crushed almonds are floating on top', 'Rider carries it like a royal drink', 'Pink, creamy and totally Instagrammable'],
  ['CHAI & COFFEE', '☕', 'Karak Chai', 100, 'Tea is boiling for the third time', 'Cardamom aroma is sneaking out of the kitchen', 'Rider is a chai lover, so he keeps checking', 'Strong enough to wake up a sleeping cat'],
  ['CHAI & COFFEE', '☕', 'Cappuccino', 300, 'Espresso shot is pulled with style', 'Milk foam is being sculpted into art', 'Rider carries it with a steady heart', 'Sip slowly. Pretend you are in Paris'],
  ['CHAI & COFFEE', '☕', 'Hot Coffee', 200, 'Beans are ground fresh', 'Hot water meets coffee: love at first sip', 'Rider hums a sleepy tune', 'Wake up, you can do it'],
  ['CHAI & COFFEE', '🍃', 'Green Tea', 90, 'Green leaves are taking a hot bath', 'Tea is turning a calm pale green', 'Rider drives peacefully for once', 'Healthy choice. Now order a cake too'],
  ['COLD DRINKS', '🧊', 'Cold Coffee', 320, 'Coffee is meeting ice cubes', 'Blender is screaming with joy', 'Rider watches the ice for any sign of crying', 'Chill. Sip. Repeat'],
  ['COLD DRINKS', '🥭', 'Mango Shake', 250, 'Sweet mangoes are being peeled', 'Blender turns them into liquid sunshine', 'Rider smells it all the way. Torture!', 'Summer in a glass'],
  ['COLD DRINKS', '🍫', 'Oreo Shake', 300, 'Oreos are bravely entering the blender', 'Cream and cookies are becoming a team', 'Rider holds the cup like a trophy', 'Black and white, but pure colour'],
  ['COLD DRINKS', '🍌', 'Banana Shake', 220, 'Bananas are saying goodbye to their peel', 'Milk and honey are joining the party', 'Rider is guarding the straw', 'Healthy-ish. We checked'],
  ['COLD DRINKS', '🥛', 'Sweet Lassi', 180, 'Fresh yoghurt is being whisked', 'Malai just jumped on top', 'Rider is slow, lassi is heavy', 'Drink it, then take a nap'],
  ['COLD DRINKS', '🍋', 'Fresh Lemonade', 120, 'Lemons were squeezed with anger', 'Mint leaves are floating like little boats', 'Rider is cool as the drink', 'Sour face first, big smile after'],
  ['COLD DRINKS', '🥤', 'Cold Drink Can', 100, 'The coldest can is being picked from the fridge', 'Fizz is loading…', 'Rider promises not to shake it', 'Burp-ready'],
  ['COLD DRINKS', '🌹', 'Rooh Afza Sharbat', 130, 'Rooh Afza is red and royal', 'Ice and milk are joining the glass', 'Rider keeps the sharbat from spilling', 'Perfect for Ramadan, and every other day'],
  ['SWEET TOOTH', '🍮', 'Gulab Jamun', 150, 'Jamuns are swimming in the syrup', 'They are getting soft and round', 'Rider counts: 2, 3, 4… still 4', 'Sweet enough to fix your mood'],
  ['SWEET TOOTH', '🍚', 'Kheer', 180, 'Rice and milk are slow-dancing', 'Cardamom and pistachios are sprinkled', 'Rider balances the bowl with both hands', 'Dessert from Nani\'s kitchen'],
  ['SWEET TOOTH', '🍨', 'Ice Cream Scoop', 200, 'Scoop is dipped in warm water', 'Two scoops are shaped like clouds', 'Rider is racing against the sun', 'Eat fast, it is melting!'],
  ['SWEET TOOTH', '🍫', 'Chocolate Brownie', 280, 'Brownie is baked to fudgy perfection', 'Chocolate sauce is flooding the plate', 'Rider is trying hard not to smile', 'Brownie + ice cream = legends'],
  ['SWEET TOOTH', '🍰', 'Chocolate Cake Slice', 300, 'The cake is cut with surgeon-like precision', 'Ganache is shining like a mirror', 'Rider carries it like a diamond', 'The cake is not a lie'],
  ['SWEET TOOTH', '🍥', 'Jalebi', 160, 'Batter is swirled into hot oil', 'Jalebis are dunking into sugar syrup', 'Rider says the box is sticky already', 'Hot jalebi with rabri. Heaven'],
  ['SWEET TOOTH', '🍡', 'Kulfi', 140, 'Kulfi is chilling in the matka', 'Pistachios are tucked in', 'Rider is racing before it melts', 'Old school, still the king'],
  ['SWEET TOOTH', '🥕', 'Gajar Halwa', 250, 'Carrots are grated and cooking in ghee', 'Khoya and nuts are joining', 'Rider smells winter in the box', 'Winter\'s love letter'],
  ['SNACKS', '🥟', 'Samosa', 40, 'Samosas are hitting the hot oil', 'They are turning crisp and golden', 'Rider: "I only counted. I swear."', 'Cheap, spicy, perfect'],
  ['SNACKS', '🧆', 'Pakora Plate', 200, 'Onion rings are dipped in besan', 'Pakoras are crackling in the pan', 'Rider drives fast — pakoras need rain', 'Rain + pakora + chai = poetry'],
  ['SNACKS', '🍿', 'Popcorn Bucket', 120, 'Kernels are heating up', 'POP POP POP — the kitchen is dancing', 'Rider is NOT eating from the bucket', 'Movie night ready'],
  ['SNACKS', '🥣', 'Dahi Bhalla', 170, 'Bhallas are soaked and soft', 'Yoghurt and chutney are layering up', 'Rider treats the bowl like a royal baby', 'Soft, sweet, tangy'],
  ['SNACKS', '🫧', 'Golgappay', 100, 'Puris are crisp and ready', 'Spicy water is chilled', 'Rider is not allowed to taste. Rules!', 'One more. One more. And one more'],
];
export const CAFE_ITEMS = R.map(([cat, emoji, name, price, prep, cook, ride, joke], i) => ({ id: i + 1, cat, emoji, name, price, prep, cook, ride, joke }));

const CAT_ICON = { 'DESI TADKA': '🍛', 'FAST FOOD': '🍔', 'CHAI & COFFEE': '☕', 'COLD DRINKS': '🥤', 'SWEET TOOTH': '🍰', SNACKS: '🍿' };

export function cafeMenuText(prefix) {
  const top = '🚪🏮━━━━━━━━━━━━━━━🏮🚪';
  const out = [top, '    ☕  *C A F F Y   M E N U*  ☕', top, ''];
  let cat = '';
  for (const it of CAFE_ITEMS) {
    if (it.cat !== cat) {
      cat = it.cat;
      out.push(`┏━━ ${CAT_ICON[cat]} *${cat}* ━━┓`);
    }
    out.push(`${String(it.id).padStart(2, '0')} ${it.emoji} ${it.name} ⋯ Rs${it.price}`);
    const next = CAFE_ITEMS[it.id];
    if (!next || next.cat !== cat) out.push('┗━━━━━━━━━━━━━━━┛', '');
  }
  out.push(`🛎️ *How to order*`, `${prefix}order 1  or  ${prefix}order biryani`, '', `🚪🏮 *${CAFE_ITEMS.length} items · enjoy!* 🏮🚪`);
  return out.join('\n');
}

export function findCafeItem(q) {
  const s = String(q || '').trim().toLowerCase();
  if (!s) return null;
  if (/^\d+$/.test(s)) return CAFE_ITEMS.find((i) => i.id === Number(s)) || null;
  return CAFE_ITEMS.find((i) => i.name.toLowerCase() === s) || CAFE_ITEMS.find((i) => i.name.toLowerCase().includes(s)) || null;
}

const bar = (n, t) => `${'▰'.repeat(n)}${'▱'.repeat(t - n)}`;
const code = (lines) => '```\n' + lines.join('\n') + '\n```';
// two walking poses — alternated from frame to frame so the person really seems to walk
const legs = (k) => (k % 2 ? [' /|\\', '  |', ' / \\', '👟 👟'] : [' /|\\', '  |', '  |', ' 👟👟']);

/** The nine edits of one order message: a little street scene (doors, people, kitchen, rider) that changes every step. `who` is "@number". */
export function cafeStages(it, who) {
  const T = 9;
  const h = (n, title) => `${it.emoji} *${title}*\n${bar(n, T)} ${Math.round((n / T) * 100)}%\n👤 ${who}`;
  const road = (a, b) => '·'.repeat(a) + '🛵💨' + '·'.repeat(b);
  return [
    // 1 — customer at home, places the order on the phone
    `${h(1, 'ORDER PLACED')}\n${code(['☁️          ☁️', '🏠🚪', '     🙂📱', ...legs(0).map((x) => '   ' + x), `"ORDER: ${it.name}"`])}\n🧾 Your *${it.name}* (Rs ${it.price}) is booked!`,
    // 2 — the order travels to the café
    `${h(2, 'ORDER SENT')}\n${code(['🏠🚪', ' 🙂📱 ═══✉️═══➜ 🏪🚪', '', '📡 sending…  ▸▸▸▸▸▸', `"1 × ${it.name}"`])}\n📨 The café just received your order.`,
    // 3 — kitchen, chef starts
    `${h(3, 'KITCHEN')}\n${code(['🏪🚪 KITCHEN', '   👨‍🍳', ...legs(1).map((x) => '  ' + x), `🔪🧅 ${it.emoji} 🍳`])}\n👨‍🍳 ${it.prep}`,
    // 4 — cooking
    `${h(4, 'COOKING')}\n${code(['  ♨️  ♨️  ♨️', `  🔥 ${it.emoji} 🔥`, '  ━━━━━━━━', '   👨‍🍳 stirring…', ...legs(0).map((x) => '  ' + x)])}\n🔥 ${it.cook}`,
    // 5 — packing
    `${h(5, 'PACKING')}\n${code(['🏪🚪', '  🧑‍🍳➜ 📦', `  📦 ${it.emoji}  🧾`, '  🥤 🧴 🥄', '  ✅ sealed & tagged'])}\n📦 ${it.name} is sealed with ${who}'s name.\n🧴 Extra napkins added.`,
    // 6 — rider picks up and leaves
    `${h(6, 'RIDER PICKED UP')}\n${code(['🏪🚪  🏍️💨', '     🙂', '    /📦\\', '   🛵 ' + '·'.repeat(8), 'engine ON · helmet ON'])}\n🛵 ${it.ride}`,
    // 7 — on the road
    `${h(7, 'ON THE WAY')}\n${code(['🌳  🏢  🌳  🚦  🏠', road(6, 4), '📍 turning into your street…'])}\n📍 Reaching ${who} very soon…`,
    // 8 — at the door, knocking
    `${h(8, 'AT YOUR DOOR')}\n${code(['    🙂📦', ...legs(0).map((x) => '  ' + x), '🏠🚪  ✊ knock knock'])}\n🔔 Rider is at your door ${who}!`,
    // 9 — delivered
    `${h(9, 'DELIVERED')}\n${code(['🏠 🚪➡️  😄📦', '        ' + '🎉', ...legs(1).map((x) => '    ' + x), `"enjoy your ${it.name}!"`])}\n✅ ${who} your *${it.name}* has arrived!\n😄 ${it.joke}\n💸 Please pay *Rs ${it.price}*`,
  ];
}
