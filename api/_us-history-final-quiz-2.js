/**
 * Fall US History final practice 2. Questions stay off the public page.
 * Weighted toward misses on practice 1, with the rest of the review sheet still in it.
 * Only the Google accounts in ALLOWED get the payload.
 */

const { readSession } = require("./_auth");

const ALLOWED = new Set([
  "you@example.com",
  "you@example.com",
  "friend@example.com",
]);

// Choice order from one Fisher-Yates pass with crypto.randomInt on 2026-11-16.
// Reloading uses this same order. Saves match the choice text.
const ORDER = {
  c02: [0, 1, 3, 2],
  c03: [2, 0, 1, 3],
  c04: [0, 3, 2, 1],
  c05: [0, 1, 2, 3],
  c06: [3, 0, 1, 2],
  c07: [2, 3, 0, 1],
  c09: [2, 0, 1, 3],
  c10: [3, 0, 1, 2],
  c11: [0, 3, 1, 2],
  c12: [3, 2, 0, 1],
  c13: [3, 1, 2, 0],
  c14: [2, 3, 0, 1],
  c15: [2, 1, 0, 3],
  c16: [2, 0, 3, 1],
  c17: [2, 3, 0, 1],
  c18: [3, 1, 2, 0],
  c19: [2, 0, 3, 1],
  c20: [2, 1, 0, 3],
  c21: [1, 0, 2, 3],
  c22: [2, 0, 3, 1],
  c23: [0, 2, 1, 3],
  c24: [3, 0, 2, 1],
  c25: [0, 2, 3, 1],
  c26: [3, 2, 0, 1],
  c27: [2, 1, 0, 3],
  c28: [3, 2, 1, 0],
  c29: [3, 1, 2, 0],
  c30: [0, 2, 3, 1],
  m01: [2, 1, 3, 0],
  m02: [0, 1, 2, 3],
  m03: [3, 1, 2, 0],
  m04: [1, 3, 2, 0],
  m05: [1, 0, 2, 3],
  m06: [3, 2, 0, 1],
  m07: [0, 3, 2, 1],
  m08: [3, 1, 0, 2],
  m09: [0, 1, 3, 2],
  m10: [2, 1, 0, 3],
  p01: [2, 1, 0, 3],
  p02: [3, 1, 2, 0],
  p03: [0, 2, 3, 1],
  p05: [0, 3, 2, 1],
  p06: [1, 0, 3, 2],
  p07: [0, 1, 3, 2],
  p08: [3, 0, 2, 1],
  p09: [0, 3, 1, 2],
  p10: [0, 3, 2, 1],
  b01: [1, 0, 2, 3],
};

function mc(id, stem, choices, answer, why) {
  const perm = ORDER[id];
  if (!perm || perm.length !== choices.length) {
    throw new Error("bad choice order for " + id);
  }
  const next = perm.map((i) => choices[i]);
  return {
    id,
    kind: "mc",
    stem,
    choices: next,
    answer: perm.indexOf(answer),
    why,
  };
}

function tf(id, stem, isTrue, why) {
  return {
    id,
    kind: "tf",
    stem,
    choices: ["True", "False"],
    answer: isTrue ? 0 : 1,
    why,
  };
}

function mapA() {
  return (
    '<svg viewBox="0 0 700 500" role="img" aria-label="Schematic of the thirteen colonies, the 1763 line, New France, and Spanish Florida">' +
    '<rect width="700" height="500" fill="#e7e1d6"/>' +
    '<rect x="28" y="36" width="210" height="300" fill="#d3cbbd"/>' +
    '<text x="133" y="160" text-anchor="middle" font-family="Karla, sans-serif" font-size="15" font-weight="700" fill="#3a342c">New France</text>' +
    '<text x="133" y="182" text-anchor="middle" font-family="Karla, sans-serif" font-size="13" fill="#3a342c">west of the line</text>' +
    '<line x1="252" y1="36" x2="252" y2="400" stroke="#3a342c" stroke-width="2" stroke-dasharray="6 5"/>' +
    '<text x="252" y="24" text-anchor="middle" font-family="Karla, sans-serif" font-size="13" fill="#3a342c">1763 line</text>' +
    '<rect x="268" y="36" width="250" height="78" fill="#8eae86"/>' +
    '<text x="393" y="68" text-anchor="middle" font-family="Karla, sans-serif" font-size="16" font-weight="700" fill="#1c2418">New England</text>' +
    '<text x="393" y="90" text-anchor="middle" font-family="Karla, sans-serif" font-size="13" fill="#1c2418">Boston</text>' +
    '<rect x="268" y="122" width="250" height="78" fill="#d2b072"/>' +
    '<text x="393" y="154" text-anchor="middle" font-family="Karla, sans-serif" font-size="16" font-weight="700" fill="#2a2114">Middle colonies</text>' +
    '<text x="393" y="176" text-anchor="middle" font-family="Karla, sans-serif" font-size="13" fill="#2a2114">Philadelphia</text>' +
    '<rect x="268" y="208" width="250" height="86" fill="#c4784e"/>' +
    '<text x="393" y="244" text-anchor="middle" font-family="Karla, sans-serif" font-size="16" font-weight="700" fill="#2a140e">Chesapeake</text>' +
    '<text x="393" y="266" text-anchor="middle" font-family="Karla, sans-serif" font-size="13" fill="#2a140e">tobacco</text>' +
    '<rect x="268" y="302" width="250" height="98" fill="#8d4548"/>' +
    '<text x="393" y="342" text-anchor="middle" font-family="Karla, sans-serif" font-size="16" font-weight="700" fill="#fff6f4">Lower South</text>' +
    '<text x="393" y="364" text-anchor="middle" font-family="Karla, sans-serif" font-size="13" fill="#fff6f4">rice and indigo</text>' +
    '<rect x="536" y="360" width="140" height="78" fill="#7d9a78"/>' +
    '<text x="606" y="394" text-anchor="middle" font-family="Karla, sans-serif" font-size="14" font-weight="700" fill="#1c2418">Spanish</text>' +
    '<text x="606" y="414" text-anchor="middle" font-family="Karla, sans-serif" font-size="14" font-weight="700" fill="#1c2418">Florida</text>' +
    '<text x="28" y="52" font-family="Karla, sans-serif" font-size="13" fill="#3a342c">N</text>' +
    "</svg>"
  );
}

function mapB() {
  return (
    '<svg viewBox="0 0 760 460" role="img" aria-label="Schematic of United States land additions from 1783 through 1848">' +
    '<rect width="760" height="460" fill="#e7e1d6"/>' +
    '<rect x="24" y="48" width="200" height="250" fill="#9bb7c9"/>' +
    '<text x="124" y="150" text-anchor="middle" font-family="Karla, sans-serif" font-size="15" font-weight="700" fill="#142028">United States</text>' +
    '<text x="124" y="172" text-anchor="middle" font-family="Karla, sans-serif" font-size="14" fill="#142028">1783</text>' +
    '<text x="124" y="194" text-anchor="middle" font-family="Karla, sans-serif" font-size="12" fill="#142028">to the Mississippi</text>' +
    '<rect x="24" y="248" width="200" height="50" fill="#8d4548"/>' +
    '<text x="124" y="278" text-anchor="middle" font-family="Karla, sans-serif" font-size="13" font-weight="700" fill="#fff6f4">Cotton belt</text>' +
    '<rect x="240" y="36" width="250" height="70" fill="#6f8f72"/>' +
    '<text x="365" y="66" text-anchor="middle" font-family="Karla, sans-serif" font-size="15" font-weight="700" fill="#142018">Oregon</text>' +
    '<text x="365" y="86" text-anchor="middle" font-family="Karla, sans-serif" font-size="13" fill="#142018">1846</text>' +
    '<rect x="240" y="114" width="250" height="150" fill="#d2b072"/>' +
    '<text x="365" y="170" text-anchor="middle" font-family="Karla, sans-serif" font-size="15" font-weight="700" fill="#2a2114">Louisiana Purchase</text>' +
    '<text x="365" y="192" text-anchor="middle" font-family="Karla, sans-serif" font-size="14" fill="#2a2114">1803</text>' +
    '<line x1="240" y1="214" x2="490" y2="214" stroke="#3a342c" stroke-width="2" stroke-dasharray="6 5"/>' +
    '<text x="365" y="234" text-anchor="middle" font-family="Karla, sans-serif" font-size="13" fill="#2a2114">1820 line</text>' +
    '<rect x="240" y="272" width="160" height="70" fill="#c4784e"/>' +
    '<text x="320" y="304" text-anchor="middle" font-family="Karla, sans-serif" font-size="14" font-weight="700" fill="#2a140e">Texas</text>' +
    '<text x="320" y="324" text-anchor="middle" font-family="Karla, sans-serif" font-size="13" fill="#2a140e">1845</text>' +
    '<rect x="410" y="272" width="180" height="120" fill="#8eae86"/>' +
    '<text x="500" y="322" text-anchor="middle" font-family="Karla, sans-serif" font-size="14" font-weight="700" fill="#1c2418">Mexican Cession</text>' +
    '<text x="500" y="342" text-anchor="middle" font-family="Karla, sans-serif" font-size="13" fill="#1c2418">1848</text>' +
    '<rect x="600" y="400" width="130" height="40" fill="#7d9a78"/>' +
    '<text x="665" y="425" text-anchor="middle" font-family="Karla, sans-serif" font-size="13" font-weight="700" fill="#1c2418">Florida 1819</text>' +
    '<text x="24" y="32" font-family="Karla, sans-serif" font-size="13" fill="#3a342c">N</text>' +
    "</svg>"
  );
}

function quizPayload() {
  const content = [
    tf(
      "c01",
      "The Mayflower Compact was the royal charter that created Massachusetts Bay Colony.",
      false,
      "The Compact was an agreement among the Pilgrims at Plymouth in 1620 to form a civil government. Massachusetts Bay had its own charter. Winthrop's Puritan colony arrived in 1630. They are not the same settlement and not the same document."
    ),
    mc(
      "c02",
      "The people who signed the Mayflower Compact settled",
      [
        "Plymouth in 1620, as Separatists",
        "Massachusetts Bay in 1630, with John Winthrop",
        "Jamestown in 1607, for the Virginia Company",
        "Rhode Island, in a colony with no established church",
      ],
      0,
      "Plymouth is the Pilgrim colony. Massachusetts Bay is the larger Puritan colony, and the city upon a hill line belongs to Winthrop, not to the Compact. Jamestown is the Chesapeake. Rhode Island is Roger Williams's later break with the Bay."
    ),
    mc(
      "c03",
      "Before European colonization in 1492, the Americas",
      [
        "already had farming societies, towns, and trade. The history does not start at Jamestown",
        "were an empty wilderness with no agriculture",
        "were governed from London under the Virginia charter",
        "began as a political story with the Mayflower Compact",
      ],
      0,
      "The review sheet asks when American history begins, and what life looked like before 1492. People were already farming, trading, and living in towns. English colonization in Virginia and New England was settler colonialism. The point was to occupy the land, not only to trade and leave."
    ),
    mc(
      "c04",
      "Maryland under the Calvert family and Pennsylvania under William Penn started as",
      [
        "proprietary colonies, granted to an owner or a group",
        "joint-stock colonies funded by investors, like Jamestown and the Virginia Company",
        "royal colonies whose governor the crown appointed",
        "Puritan colonies that required full church membership to vote",
      ],
      0,
      "Proprietary means the king granted the territory to proprietors. Joint-stock means a company of investors, which is Jamestown. Royal means a governor named by the crown. Virginia later became royal. Church membership as a voting rule is Massachusetts Bay, a different kind of restriction."
    ),
    mc(
      "c05",
      "John Locke's argument, the one the class tied to the Declaration, was that",
      [
        "people have natural rights, and legitimate government rests on their consent",
        "power should be split so that no one branch holds all of it",
        "the king is above the law because God chose him",
        "the Iroquois Great Law of Peace was an act of Parliament",
      ],
      0,
      "Locke is life, liberty, and property, and consent. Montesquieu is the separation of powers. Divine right is the theory the Declaration rejects. The Magna Carta and the English Bill of Rights are the earlier English limits on the king. The Iroquois Great Law of Peace is the indigenous political influence on that same list. It is not an English statute."
    ),
    mc(
      "c06",
      "Britain drew the Proclamation line in 1763 in order to",
      [
        "keep settlers east of the Appalachians after the Seven Years' War and Pontiac's War",
        "collect a stamp tax on colonial newspapers and legal papers",
        "punish Boston for the Tea Party",
        "return the Ohio country to France",
      ],
      0,
      "The line was a western boundary. It was cheaper than guarding settlers in Indian country. The Stamp Act is 1765, an internal tax on paper. The Tea Party is 1773. France had already lost that territory. On the map, legal settlement is east of the line."
    ),
    mc(
      "c07",
      "The western border of the United States at the Mississippi River was set by",
      [
        "the Treaty of Paris in 1783, which ended the Revolutionary War",
        "the Proclamation of 1763, which Britain never repealed",
        "the Adams-Onis Treaty",
        "the Missouri Compromise",
      ],
      0,
      "Britain recognized independence and ceded to the Mississippi. The Proclamation line was the Appalachians, and independence ended that British rule. Adams-Onis is Florida, from Spain, in 1819. The Missouri Compromise drew a slavery line inside the Louisiana Purchase. It did not set the 1783 border."
    ),
    tf(
      "c08",
      "The American Revolution abolished slavery in every state by the time the Treaty of Paris was signed.",
      false,
      "Northern states began gradual emancipation. Pennsylvania's law is 1780. The Lower South kept slavery. Women did not gain the vote. The review question is how revolutionary the Revolution was. Liberty widened for many white men and stopped short of a lot of other people. Saratoga in 1777 brought France in. Yorktown in 1781 ended the fighting. The treaty is 1783."
    ),
    mc(
      "c09",
      "The Northwest Ordinance of 1787 banned slavery",
      [
        "in the territory north of the Ohio River",
        "in the Southwest, and it opened the international slave trade",
        "across the cotton kingdom of the Deep South",
        "inside the thirteen original states only",
      ],
      0,
      "North of the Ohio. It did not cover the Southwest, and it did not reopen the import trade. It also set the steps for a territory to become a state and promised support for schools. That is one of the Articles government's real successes. Congress under the Articles still could not levy a tax. Shays' Rebellion in 1786 and 1787 made that weakness look dangerous."
    ),
    mc(
      "c10",
      "The ordinance of 1785 and the Northwest Ordinance of 1787 split the work this way",
      [
        "1785 surveyed townships. 1787 set up territorial government and banned slavery north of the Ohio",
        "1785 banned slavery in the Southwest. 1787 opened the international slave trade",
        "1785 gave Congress a power to tax. 1787 ended Shays' Rebellion by itself",
        "both laws bought Florida from Spain",
      ],
      0,
      "1784 was Jefferson's earlier plan for stages of government, and the slavery ban in that draft failed. 1785 is the grid. 1787 is the government, the slavery ban north of the Ohio, and support for schools. The Great Compromise and the three-fifths clause are later, at the Philadelphia convention. They are not these land laws."
    ),
    mc(
      "c11",
      "The fugitive slave clause in the Constitution required that",
      [
        "an enslaved person who escaped to another state be returned",
        "three fifths of the enslaved population count toward House seats and direct taxes",
        "Congress wait until 1808 before it could ban the international slave trade",
        "each state get two senators no matter its population",
      ],
      0,
      "That is Article IV. The three-fifths clause is Article I, Section 2. It is representation and taxes, not a return rule. The slave-trade clause is Article I, Section 9, the delay until 1808. Two senators per state is the Connecticut Compromise. Three different fights."
    ),
    mc(
      "c12",
      "The Tenth Amendment says that powers not given to the federal government, and not forbidden to the states,",
      [
        "are reserved to the states or to the people",
        "belong to the president as commander in chief",
        "let the Supreme Court strike down any federal law it dislikes",
        "were already written into the 1787 text as a bill of rights",
      ],
      0,
      "That is the federalism amendment. The first ten amendments were ratified in 1791. They were not in the Constitution signed at Philadelphia. The First Amendment is speech, religion, press, assembly, and petition. Declaring war is a listed power of Congress. The president commands the forces once they exist."
    ),
    mc(
      "c13",
      "The Neutrality Proclamation of 1793 and Washington's Farewell Address are",
      [
        "two documents. The 1793 proclamation kept the country out of France's war. The Farewell is 1796",
        "the same speech, printed under two titles",
        "both orders to sign a permanent alliance with Britain against Spain",
        "Jefferson's answers to the Alien and Sedition Acts",
      ],
      0,
      "Washington issued the Neutrality Proclamation in 1793 so the United States would not join the war between France and the European monarchies, even with the 1778 French treaty on the books. The Farewell Address is 1796, when he refused a third term. The Alien and Sedition Acts are 1798, and the Virginia and Kentucky Resolutions are the answer to those."
    ),
    mc(
      "c14",
      "On foreign nations, the Farewell Address tells the United States to",
      [
        "extend trade and avoid permanent alliances, including an alliance with Britain",
        "sign a permanent alliance with Britain against Spain",
        "join France's wars to repay the 1778 treaty",
        "close every American port to foreign merchants",
      ],
      0,
      "He separates commerce from political ties. As little political connection as possible, and no permanent alliance with any part of the foreign world. That includes Britain. It is not a ban on trade, and it is not a call to fight for France."
    ),
    mc(
      "c15",
      "The election of 1800 mattered because",
      [
        "power passed from the Federalists to Jefferson's party without a coup. Adams left. The House picked Jefferson after a tie with Burr",
        "Adams refused to leave office until the army removed him",
        "the House chose Aaron Burr, and the 11th Amendment stopped a repeat",
        "it was the first election in which the people voted directly for senators",
      ],
      0,
      "Jefferson and Burr tied in the electoral college. The House chose Jefferson. The 12th Amendment, ratified in 1804, votes for president and vice president separately. Senators stayed chosen by state legislatures. Federalists and Democratic-Republicans were already the two parties. Jefferson's side wanted a narrower federal government and an agrarian republic. That is the Jeffersonian democracy on the review sheet."
    ),
    mc(
      "c16",
      "Jefferson's objection to Hamilton's national bank was that",
      [
        "the Constitution did not list a power to create a bank. Hamilton answered with the necessary and proper clause",
        "the bank would move the capital to New York and abolish the tariff",
        "the Farewell Address had already banned every bank",
        "the bank was the machine Eli Whitney patented to clean cotton",
      ],
      0,
      "Assumption of state debts, the Bank of the United States, and revenue from a tariff and an excise are the plan. The capital went to the Potomac as part of the bargain, not to New York. The fight is enumerated powers against the necessary and proper clause."
    ),
    mc(
      "c17",
      "In 1803 the United States bought Louisiana from",
      [
        "France",
        "Spain",
        "Britain",
        "Mexico",
      ],
      0,
      "Napoleon sold it. Spain had held the territory and ceded it to France on paper before the sale. The seller in 1803 was France. Jefferson worried that a strict reading of the Constitution did not list a power to buy land, then took the deal. Florida, from Spain, is a different treaty."
    ),
    mc(
      "c18",
      "The Adams-Onis Treaty of 1819",
      [
        "transferred Florida from Spain to the United States",
        "drew the 36°30' line and admitted Maine as a free state",
        "was the French sale of Louisiana",
        "ended the Mexican-American War",
      ],
      0,
      "John Quincy Adams negotiated it with Spain. Florida is the cession. The Missouri Compromise is 1820, a slavery bargain, not a purchase. Louisiana was the French sale in 1803. The war with Mexico ends in 1848 with the Treaty of Guadalupe Hidalgo."
    ),
    mc(
      "c19",
      "The Missouri Compromise of 1820 did all of the following except",
      [
        "buy Florida from Spain",
        "admit Missouri as a slave state",
        "admit Maine as a free state",
        "ban slavery in the Louisiana Purchase north of 36°30', except in Missouri",
      ],
      0,
      "Read the except. Florida was Adams-Onis, already done. The compromise paired Missouri and Maine so the Senate stayed even, and it closed the rest of the Purchase north of the line to slavery. The line did not cover land the country did not yet hold."
    ),
    mc(
      "c20",
      "The Monroe Doctrine (1823) declared that",
      [
        "the Americas were closed to new European colonization, and the United States would stay out of European wars",
        "Florida and Louisiana had been bought from Spain in one treaty",
        "slavery was banned north of 36°30' in every territory the country would ever gain",
        "the United States was required to annex Texas that year",
      ],
      0,
      "John Quincy Adams shaped the message. It is foreign policy, not a land cession and not a slavery line. Manifest Destiny is the later name for the expansion idea. Texas annexation is 1845, not 1823."
    ),
    mc(
      "c21",
      "The Mexican-American War, fought from 1846 to 1848, ended with",
      [
        "the Treaty of Guadalupe Hidalgo and the Mexican Cession",
        "the Louisiana Purchase",
        "the Adams-Onis Treaty",
        "the annexation of Texas, which was still in the future",
      ],
      0,
      "The Cession is the land Mexico gave up, including California. Texas was annexed in 1845, before the war. The Oregon Treaty of 1846 set the line with Britain at the 49th parallel. That is a separate deal. Manifest Destiny is the name for the expansion drive. It is not itself a treaty."
    ),
    mc(
      "c22",
      "The Compromise of 1850",
      [
        "admitted California as a free state and let Utah and New Mexico decide slavery by popular sovereignty",
        "banned slavery in the entire Mexican Cession",
        "bought Florida and repealed the Missouri line inside Missouri",
        "was the treaty that ended the Mexican-American War",
      ],
      0,
      "Popular sovereignty means the settlers of a territory vote on slavery. The 1850 bargain also brought a tougher fugitive slave law and ended the slave trade in Washington, D.C., without ending slavery there. The war's treaty is 1848. Florida is 1819."
    ),
    mc(
      "c23",
      "The mills at Waltham and Lowell are best described as",
      [
        "water-powered textile factories that hired young women from New England farms and housed many of them in boardinghouses",
        "plantations that paid enslaved spinners a wage and a garden plot",
        "the Georgia shops where Eli Whitney built the cotton gin",
        "the wire lines Samuel Morse used for the telegraph",
      ],
      0,
      "The power loom at Waltham is 1814. Lowell sits on the Merrimack. Boardinghouses were how the owners got farm parents to let daughters leave home. The cotton gin is 1793, in Georgia, and it expanded slavery. The telegraph is the other market-revolution change, news by wire. The Erie Canal, finished in 1825, linked the Great Lakes to New York. None of those is a plantation."
    ),
    mc(
      "c24",
      "The cotton gin and the closing of the international slave trade in 1808 together meant that",
      [
        "short-staple cotton spread inland, and a domestic trade carried enslaved people from the Upper South into the cotton states",
        "planters could harvest cotton with no field workers",
        "New England mills replaced southern cotton with wool spun at Lowell",
        "the Northwest Ordinance reopened imports from Africa",
      ],
      0,
      "Whitney's gin, 1793, cleaned the seeds out of short-staple cotton and pushed the crop, and slavery, into the Deep South. The Constitution barred a ban on the import trade before 1808. After imports were illegal, the Upper South sold people south. Most white southern households did not enslave anyone. Planters still ran southern politics."
    ),
    mc(
      "c25",
      "Nat Turner's 1831 revolt and the first issue of The Liberator are",
      [
        "two different events that year. Turner led a revolt in Virginia. Garrison started the paper in Boston",
        "the same event. Turner edited the paper",
        "both projects of the American Colonization Society",
        "the battles that ended the Mexican-American War",
      ],
      0,
      "The Liberator's first issue is January 1, 1831. Turner's revolt in Southampton County, Virginia, is that August. Virginia answered it with harsher laws. Denmark Vesey's plot in Charleston was 1822, and it was stopped beforehand. Gabriel's conspiracy near Richmond was 1800."
    ),
    mc(
      "c26",
      "The American Colonization Society, founded in 1816, wanted",
      [
        "gradual emancipation paired with sending free Black Americans to Africa",
        "immediate abolition in the United States, with no apology for harsh language",
        "votes for women, starting at Seneca Falls",
        "a national ban on alcohol as its only goal",
      ],
      0,
      "The society tied freedom to removal. Liberia was the colony that plan produced. Garrison broke with it. Seneca Falls is the women's-rights convention in 1848. Temperance is the separate reform aimed at alcohol."
    ),
    mc(
      "c27",
      "Garrison's refusal to write with moderation was first printed in",
      [
        "The Liberator, which he started in Boston in 1831",
        "an American Colonization Society pamphlet in 1816",
        "the Declaration of Sentiments at Seneca Falls in 1848",
        "Washington's Farewell Address in 1796",
      ],
      0,
      "The lines are the first issue of The Liberator, January 1, 1831. They are an immediatist manifesto. They are not a colonization pamphlet, not the women's declaration, and not Washington."
    ),
    mc(
      "c28",
      "Set next to the American Colonization Society, Garrison argued that slavery should",
      [
        "end now, in the United States, and not by shipping Black Americans to Africa as the plan",
        "be left to each state, with no public criticism allowed",
        "end only after every enslaver was paid and every free person left for Liberia",
        "expand past the 1820 line so the mills would have cotton",
      ],
      0,
      "Colonization paired gradual emancipation with removal to Africa. Garrison rejected the silence and the removal. Leaving it to each state with no criticism is the opposite of The Liberator. Compensation plus Liberia is the plan he was attacking."
    ),
    mc(
      "c29",
      "Frederick Douglass belongs with the abolitionists as",
      [
        "a man who escaped slavery, published his Narrative, and demanded freedom in the United States",
        "the founder of the American Colonization Society",
        "the author of the Declaration of Sentiments",
        "the inventor of the cotton gin",
      ],
      0,
      "Douglass escaped slavery in Maryland. The Narrative of the Life of Frederick Douglass is 1845. He argued for immediate abolition here. Elizabeth Cady Stanton and Lucretia Mott are the organizers tied to Seneca Falls. Susan B. Anthony became a central figure in the women's movement after that convention. Whitney built the gin."
    ),
    mc(
      "c30",
      "The Seneca Falls convention in 1848 produced",
      [
        "the Declaration of Sentiments, demanding rights for women, including the vote",
        "The Liberator's pledge to use harsh language",
        "the American Colonization Society's plan for a colony in Africa",
        "the temperance movement's call to restrict alcohol",
      ],
      0,
      "Stanton and Mott are the names tied to that meeting. The Sentiments rewrote all men are created equal as all men and women, and they named the vote. Temperance is the alcohol reform on the same list. It is not this document. Garrison's paper is 1831. The colonization society is 1816."
    ),
  ];

  const maps = [
    mc(
      "m01",
      "On map A, the block labeled tobacco is the",
      [
        "Chesapeake",
        "New England",
        "Middle colonies",
        "Spanish Florida",
      ],
      0,
      "Virginia and Maryland grew tobacco. Early labor there was mostly indentured servants. Lifetime racial slavery hardened later in the 1600s. New England is towns and small farms. The middle colonies are wheat and ports. Spanish Florida is not an English colony."
    ),
    mc(
      "m02",
      "Philadelphia is marked with the middle colonies. Those colonies were known for",
      [
        "wheat, busy ports, and a mix of religions and ethnic groups",
        "a Puritan rule that every voter be a full church member",
        "rice as the only crop the Navigation Acts allowed",
        "gold mines worked under the headright system",
      ],
      0,
      "Pennsylvania, New York, and New Jersey drew Quakers, Dutch, Germans, and others. The church-membership voting rule is Massachusetts Bay. Rice and indigo are the Lower South, the block under the Chesapeake."
    ),
    mc(
      "m03",
      "Boston is marked in New England. Ordinary settlement there was",
      [
        "towns, small farms, and a Puritan church, not staple plantations",
        "rice plantations on a task system",
        "one royal plantation owned by the Baltimore family",
        "the same colony as Plymouth, under the same charter",
      ],
      0,
      "New England's economy was mixed farming, timber, fish, and trade. Plymouth and Massachusetts Bay both sit in this region, and they are not the same colony. The Compact is Plymouth. The Bay charter is Winthrop's colony. Baltimore's grant is Maryland, in the Chesapeake. Rice is the Lower South."
    ),
    mc(
      "m04",
      "The dashed 1763 line on map A is the Proclamation line. Colonists were told to stay",
      [
        "east of it",
        "west of it, and leave the coast to the army",
        "south of the Lower South only",
        "inside Spanish Florida until the Stamp Act expired",
      ],
      0,
      "The Appalachian line was the western edge of legal British settlement. New France is the label west of it on this map. The Stamp Act is a later tax on paper. It is not this line."
    ),
    mc(
      "m05",
      "The blocks marked New France and Spanish Florida are",
      [
        "claims of other European empires, not two of the thirteen English colonies",
        "the joint-stock colonies of the Virginia Company",
        "the proprietary colonies of Penn and Calvert",
        "the states added by the Missouri Compromise",
      ],
      0,
      "The review sheet asks for the other European empires in North America, not only the thirteen. New France is the French claim. Spanish Florida is Spain's. The thirteen English colonies are the coastal blocks from New England through the Lower South. The Missouri Compromise is 1820. It is not on this map."
    ),
    mc(
      "m06",
      "On map B, the Louisiana Purchase block, dated 1803, was sold to the United States by",
      [
        "France",
        "Spain",
        "Britain",
        "Mexico",
      ],
      0,
      "Napoleon sold it. Spain had held it earlier. The seller in 1803 was France. Florida, the small 1819 block, is the Spanish cession. Mexico is the 1848 block."
    ),
    mc(
      "m07",
      "The Florida block, dated 1819, came from Spain by the",
      [
        "Adams-Onis Treaty",
        "Missouri Compromise",
        "Louisiana Purchase",
        "Treaty of Guadalupe Hidalgo",
      ],
      0,
      "Adams-Onis is the Florida treaty. The Missouri Compromise drew a slavery line. It did not buy land. Louisiana was the French sale. Guadalupe Hidalgo ended the Mexican-American War in 1848."
    ),
    mc(
      "m08",
      "The 1783 block stops at the Mississippi. That border was set by the",
      [
        "Treaty of Paris, which ended the Revolutionary War",
        "Proclamation of 1763, which Britain never repealed",
        "Adams-Onis Treaty",
        "Monroe Doctrine",
      ],
      0,
      "The Proclamation line was the Appalachians. Independence wiped that British rule out and put the border at the river. Adams-Onis is Florida. The Monroe Doctrine is 1823 foreign policy, not a border treaty."
    ),
    mc(
      "m09",
      "The dashed 1820 line across the Louisiana Purchase",
      [
        "banned slavery north of that line in the Purchase, except inside Missouri",
        "bought Florida and made Maine a slave state",
        "set the western border of the United States at the Appalachians",
        "opened the international slave trade for another twenty years",
      ],
      0,
      "Missouri entered as a slave state and Maine as a free state. The rest of the Purchase north of 36°30' was closed to slavery. The Appalachian line is 1763. The import trade had already closed in 1808. The cotton belt on the 1783 block is where the domestic trade carried people from the Upper South after that date."
    ),
    mc(
      "m10",
      "The block dated 1848 and labeled Mexican Cession is",
      [
        "land Mexico ceded after the war, not Texas and not Oregon",
        "the Louisiana Purchase under another name",
        "Florida, bought in the Missouri Compromise",
        "the Oregon Treaty country, dated 1846",
      ],
      0,
      "Texas is the 1845 block, annexed before the war. Oregon is the 1846 treaty with Britain. The Mexican Cession is the 1848 treaty with Mexico. Three additions, three dates. None of them is Louisiana or Florida."
    ),
  ];

  const sources = [
    {
      id: "declaration",
      title: "Source A. Declaration of Independence, 1776",
      text:
        "We hold these truths to be self-evident, that all men are created equal, that they are endowed by their Creator with certain unalienable Rights, that among these are Life, Liberty and the pursuit of Happiness. That to secure these rights, Governments are instituted among Men, deriving their just powers from the consent of the governed.",
    },
    {
      id: "farewell",
      title: "Source B. Washington, Farewell Address, 1796",
      text:
        "Let me warn you in the most solemn manner against the baneful effects of the spirit of party. The great rule of conduct for us in regard to foreign nations is, in extending our commercial relations, to have with them as little political connection as possible. It is our true policy to steer clear of permanent alliances with any portion of the foreign world.",
    },
    {
      id: "sentiments",
      title: "Source C. Declaration of Sentiments, Seneca Falls, 1848",
      text:
        "We hold these truths to be self-evident: that all men and women are created equal; that they are endowed by their Creator with certain inalienable rights; that among these are life, liberty, and the pursuit of happiness. He has never permitted her to exercise her inalienable right to the elective franchise. We insist that they have immediate admission to all the rights and privileges which belong to them as citizens of these United States.",
    },
  ];

  const primary = [
    mc(
      "p01",
      "In source A, deriving just powers from the consent of the governed is closest to",
      [
        "the claim that legitimate government rests on the people, not on a king's birth",
        "the divine right of kings",
        "Parliament's claim that virtual representation already included the colonies",
        "the three-fifths rule",
      ],
      0,
      "Jefferson is using the liberal argument from the British-traditions notes. Authority comes from consent. Divine right and virtual representation are what the Declaration is rejecting. The three-fifths clause is the Constitution, eleven years later."
    ),
    mc(
      "p02",
      "The main author of source A was",
      [
        "Thomas Jefferson",
        "Thomas Paine",
        "George Washington",
        "John Dickinson",
      ],
      0,
      "Congress edited Jefferson's draft. Paine wrote Common Sense, which pushed independence in plain language in January 1776. Washington commanded the army. Dickinson wrote Letters from a Farmer and then opposed the break."
    ),
    mc(
      "p03",
      "On foreign nations, source B tells the United States to",
      [
        "trade widely and avoid permanent alliances, including with Britain",
        "sign a permanent alliance with Britain against Spain",
        "honor the 1778 French treaty by joining France's wars",
        "close every port to foreign merchants",
      ],
      0,
      "Commercial relations, and as little political connection as possible. No permanent alliance with any portion of the foreign world. That sentence includes Britain. It does not ban trade, and it does not send the country into France's war."
    ),
    tf(
      "p04",
      "Source B is the Neutrality Proclamation of 1793.",
      false,
      "Both are Washington, and they point the same direction, but they are not the same document. The Neutrality Proclamation is 1793, the statement that the country was staying out of the European war. The Farewell Address is 1796, when he refused a third term."
    ),
    mc(
      "p05",
      "The spirit of party in source B refers to",
      [
        "factions, including the Federalist and Republican split already underway",
        "the committees of correspondence in the 1760s",
        "party platforms the Constitution required",
        "nominating conventions created by the 12th Amendment",
      ],
      0,
      "By 1796 the country already had Federalists and Democratic-Republicans. The Constitution does not set up parties. The 12th Amendment, ratified in 1804, separates the presidential and vice-presidential ballots. It does not create conventions."
    ),
    mc(
      "p06",
      "Source B dates to the moment when Washington",
      [
        "refused a third term, in 1796",
        "issued the Neutrality Proclamation and nothing else",
        "signed the Treaty of Paris in 1783",
        "bought Louisiana from France",
      ],
      0,
      "The Farewell is the 1796 exit. The Neutrality Proclamation is three years earlier. The Treaty of Paris ended the war. The Louisiana Purchase is Jefferson, in 1803."
    ),
    mc(
      "p07",
      "Source C's line that all men and women are created equal is",
      [
        "a rewrite of the Declaration of Independence, adopted at Seneca Falls in 1848",
        "the 1776 text, unchanged, including the word women",
        "Garrison's opening of The Liberator in 1831",
        "the charter of the American Colonization Society",
      ],
      0,
      "The Sentiments keep Jefferson's rhythm and add women. The 1776 Declaration says all men. The Liberator is Garrison's immediatist paper. The colonization society, founded in 1816, wanted gradual emancipation plus removal to Africa."
    ),
    mc(
      "p08",
      "In source C, the elective franchise means",
      [
        "the vote, which the document says women have been denied",
        "a tax on imported French wine",
        "a seat in the House under the three-fifths clause",
        "a plot of land under the 1785 survey",
      ],
      0,
      "Franchise here is the right to vote. The Sentiments demand it for women, along with the other rights of citizens. It is not a tariff, not the three-fifths clause, and not the land grid."
    ),
    mc(
      "p09",
      "Source C was adopted at",
      [
        "the Seneca Falls convention in 1848",
        "the first issue of The Liberator in 1831",
        "the founding of the American Colonization Society in 1816",
        "the signing of the Neutrality Proclamation in 1793",
      ],
      0,
      "Elizabeth Cady Stanton and Lucretia Mott are the organizers tied to Seneca Falls. Susan B. Anthony became a central figure in the women's movement after that convention. She did not write this 1848 document. Garrison, the colonization society, and Washington's 1793 proclamation are other items on the review sheet."
    ),
    mc(
      "p10",
      "Set next to temperance, abolition, and colonization, source C is",
      [
        "the women's rights argument, including the vote",
        "a plea to restrict alcohol",
        "Garrison's demand for immediate abolition with no moderation",
        "a plan to send free Black Americans to Liberia",
      ],
      0,
      "Temperance is the alcohol reform. Garrison and The Liberator are militant abolition. The American Colonization Society is the Liberia plan. The Sentiments are the women's movement. Same era on the review sheet, four different projects."
    ),
  ];

  const bonus = [
    mc(
      "b01",
      "Besides the ban on slavery north of the Ohio, the Northwest Ordinance of 1787",
      [
        "set rules for a territory to become a state and promised support for schools",
        "opened the international slave trade and banned slavery in the Southwest",
        "gave Congress the tax power the Articles were missing",
        "returned the Ohio country to France",
      ],
      0,
      "The slavery ban is north of the Ohio, not in the Southwest, and the ordinance did not reopen the import trade. Statehood rules and support for schools are the other pieces. The tax power is still missing under the Articles. France did not get the Ohio country back. The Proclamation line was already a dead British rule by 1787."
    ),
  ];

  return {
    quizId: "us-history-fall-final-2",
    total: content.length + maps.length + primary.length + bonus.length,
    content,
    maps,
    mapA: mapA(),
    mapB: mapB(),
    sources,
    primary,
    bonus,
  };
}

async function sendHistoryFinal2(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ ok: false, error: "method not allowed" });
    return;
  }

  res.setHeader("Cache-Control", "no-store");
  const session = readSession(req);
  if (!session || !session.email) {
    res.status(401).json({ ok: false, error: "sign in" });
    return;
  }
  if (!ALLOWED.has(session.email)) {
    res.status(403).json({ ok: false, error: "not allowed" });
    return;
  }

  res.status(200).json({ ok: true, email: session.email, ...quizPayload() });
}

module.exports = { sendHistoryFinal2, quizPayload, ALLOWED };
