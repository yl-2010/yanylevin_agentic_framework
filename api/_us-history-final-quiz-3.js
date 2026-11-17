/**
 * Fall US History final practice 3. Questions stay off the public page.
 * Leans on the misses from practices 1 and 2, slavery, and the Mexican-American War,
 * with the rest of the review sheet still in it.
 * Only the Google accounts in ALLOWED get the payload.
 */

const { readSession } = require("./_auth");

const ALLOWED = new Set([
  "you@example.com",
  "you@example.com",
  "friend@example.com",
]);

const BASE = "/us-history/fall-final-3-jmzm/";

// Choice order from crypto.randomInt on 2026-11-17, balanced across A to D with no letter three times in a row.
const ORDER = {
  c01: [2, 0, 1, 3],
  c02: [3, 0, 2, 1],
  c04: [2, 3, 0, 1],
  c05: [3, 1, 0, 2],
  c06: [0, 2, 3, 1],
  c07: [3, 1, 2, 0],
  c09: [1, 0, 3, 2],
  c11: [3, 1, 0, 2],
  c12: [0, 1, 3, 2],
  c14: [3, 1, 0, 2],
  c15: [3, 1, 0, 2],
  c16: [3, 2, 1, 0],
  c18: [1, 0, 3, 2],
  c19: [3, 1, 2, 0],
  c20: [0, 2, 3, 1],
  c21: [3, 0, 1, 2],
  c22: [0, 3, 2, 1],
  c23: [2, 0, 1, 3],
  c24: [0, 1, 2, 3],
  c28: [2, 0, 3, 1],
  c29: [2, 3, 0, 1],
  c30: [0, 2, 1, 3],
  m01: [0, 1, 2, 3],
  m02: [3, 2, 0, 1],
  m03: [2, 3, 1, 0],
  m04: [1, 0, 2, 3],
  m05: [1, 2, 3, 0],
  m06: [1, 2, 3, 0],
  m07: [0, 1, 3, 2],
  m08: [3, 0, 1, 2],
  m09: [2, 1, 0, 3],
  m10: [1, 0, 3, 2],
  p01: [2, 1, 3, 0],
  p02: [1, 2, 3, 0],
  p03: [1, 2, 0, 3],
  p04: [1, 2, 3, 0],
  p05: [3, 2, 0, 1],
  p06: [0, 3, 1, 2],
  p07: [1, 3, 2, 0],
  p08: [0, 2, 3, 1],
  p09: [0, 1, 3, 2],
  p10: [1, 0, 3, 2],
  b01: [3, 1, 0, 2],
};

function mc(id, stem, choices, why) {
  const perm = ORDER[id];
  if (!perm || perm.length !== choices.length) {
    throw new Error("bad choice order for " + id);
  }
  return {
    id,
    kind: "mc",
    stem,
    choices: perm.map((i) => choices[i]),
    answer: perm.indexOf(0),
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

// Every mc() lists the correct choice first. ORDER moves it.
function quizPayload() {
  const content = [
    mc(
      "c01",
      "Which statement best describes the Americas before 1492?",
      [
        "Millions of people lived in farming towns linked by trade",
        "A thinly settled land of small hunting bands that moved with the seasons",
        "A region whose people had no organized governments",
        "A land whose people had not yet begun to farm",
      ],
      "The Indigenous America lesson and Dunbar-Ortiz make this point. The continent was crowded with farming societies, towns, and trade routes long before Columbus. The map of Indigenous nations on the maps page is there for the same reason."
    ),
    mc(
      "c02",
      "Virginia began in 1607 as a ______ colony and became a ______ colony in 1624.",
      ["joint-stock, royal", "proprietary, royal", "royal, proprietary", "joint-stock, proprietary"],
      "The Virginia Company of London, a group of investors, paid for Jamestown. When the company failed, the crown took over in 1624 and named the governor. Maryland under the Calverts and Pennsylvania under Penn are the proprietary examples."
    ),
    tf(
      "c03",
      "John Winthrop gave his \"City upon a Hill\" sermon to the Separatist Pilgrims who founded Plymouth in 1620.",
      false,
      "Winthrop led the Puritans of Massachusetts Bay in 1630. Puritans wanted to reform the Church of England from inside. The Pilgrims were Separatists who left it, and they signed the Mayflower Compact before landing at Plymouth. Two groups, two colonies, ten years apart."
    ),
    mc(
      "c04",
      "For most of the 1600s, the largest share of field labor on Chesapeake tobacco farms came from",
      [
        "indentured servants from England",
        "enslaved Africans shipped from the Caribbean",
        "free farm families who owned small plots",
        "Native Americans paid wages in trade goods",
      ],
      "Most early Chesapeake workers were young English servants who worked four to seven years to pay for the voyage. Planters shifted to enslaved Africans late in the century, as servants got scarcer and the colonies wrote lifelong, inherited slavery into law."
    ),
    mc(
      "c05",
      "Which pairing of a thinker or document with an idea is correct?",
      [
        "Montesquieu: separate the branches of government",
        "Locke: kings rule by divine right, not consent",
        "Magna Carta: every free adult man has the vote",
        "Great Law of Peace: one chief rules all five nations",
      ],
      "Montesquieu argued for splitting legislative, executive, and judicial power. Locke is natural rights and consent of the governed. The Magna Carta (1215) limited the king. It did not create a vote. The Great Law of Peace joined the Iroquois nations under a shared council."
    ),
    mc(
      "c06",
      "Many colonists were angry about the Proclamation of 1763 because it",
      [
        "barred settlement west of the Appalachian Mountains",
        "taxed paper goods such as newspapers and deeds",
        "closed Boston Harbor until the tea was paid for",
        "required colonists to house and supply British troops",
      ],
      "After the Seven Years' War and Pontiac's War, Britain drew the line to keep settlers off Native land and avoid another costly war. Colonists who fought for the Ohio country felt cheated. The others are the Stamp Act (1765), the Coercive Acts (1774), and the Quartering Act (1765)."
    ),
    mc(
      "c07",
      "In 1775 Lord Dunmore, the royal governor of Virginia, offered freedom to",
      [
        "enslaved men who escaped to fight for the British",
        "any colonist who swore loyalty to the king",
        "indentured servants who joined the Continental Army",
        "enslaved people held by loyalist planters",
      ],
      "Dunmore's Proclamation promised freedom to enslaved men and servants of rebel masters who joined British forces. Thousands ran to British lines during the war. It pushed many white Virginians toward independence, and it is a core example for \"A Revolution for Whom?\""
    ),
    tf(
      "c08",
      "The American victory at Saratoga in 1777 helped convince France to sign a formal alliance with the United States.",
      true,
      "Saratoga is the turning point. France signed the alliance in 1778, and French troops and ships helped trap Cornwallis at Yorktown in 1781. The Treaty of Paris ended the war in 1783."
    ),
    mc(
      "c09",
      "Shays' Rebellion (1786 to 1787) alarmed many leaders because it showed that the national government under the Articles",
      [
        "could not raise an army or taxes to restore order",
        "had grown too strong and was taxing farmers",
        "had given the president too much military power",
        "had let the Supreme Court overturn state laws",
      ],
      "Indebted Massachusetts farmers shut down the courts. Congress under the Articles could not tax and had no real army, so Massachusetts paid a private militia. There was no president and no national court yet. The scare pushed leaders toward the 1787 convention."
    ),
    tf(
      "c10",
      "The Northwest Ordinance of 1787 banned slavery in the lands south of the Ohio River that became Kentucky and Tennessee.",
      false,
      "The ban covered the Northwest Territory, north of the Ohio River, which became Ohio, Indiana, Illinois, Michigan, and Wisconsin. South of the river slavery stayed legal. The ordinance also set the steps to statehood and backed public schools."
    ),
    mc(
      "c11",
      "The Connecticut (Great) Compromise settled the fight between large and small states by",
      [
        "using population for the House and equal votes in the Senate",
        "giving each state one vote in a single-house Congress",
        "basing both houses of Congress on each state's population",
        "counting three fifths of enslaved people for House seats",
      ],
      "The Virginia Plan wanted both houses by population. The New Jersey Plan kept one vote per state, like the Articles. Roger Sherman's compromise split the difference. The three-fifths clause was a separate deal about counting enslaved people."
    ),
    mc(
      "c12",
      "The Constitution's slave trade clause (Article I, Section 9)",
      [
        "barred Congress from banning slave imports before 1808",
        "required escaped slaves to be returned to their owners",
        "counted three fifths of enslaved people toward House seats",
        "ended the international slave trade in 1787",
      ],
      "Congress could not ban the import of enslaved people until 1808, and it banned it that year. Returning people who escaped is the fugitive slave clause in Article IV. Three fifths is Article I, Section 2."
    ),
    tf(
      "c13",
      "Under the three-fifths clause, enslaved men could cast three fifths of a vote in federal elections.",
      false,
      "Enslaved people could not vote at all. The clause counted three fifths of the enslaved population when dividing House seats and direct taxes. That gave slaveholding states extra seats in the House and extra votes in the Electoral College."
    ),
    mc(
      "c14",
      "Which of these is a power the Constitution gives to Congress rather than to the president?",
      ["declaring war on a nation", "commanding the armed forces", "vetoing a bill", "issuing executive orders"],
      "Article I gives Congress the power to declare war and to fund the military. Article II makes the president commander in chief. The veto is the president's check on Congress, and two thirds of both houses can override it."
    ),
    mc(
      "c15",
      "Anti-Federalists in several states agreed to ratification mainly because Federalists promised to",
      [
        "add amendments that protect individual rights",
        "drop the Senate and return to a one-house Congress",
        "let each state keep its own army and currency",
        "elect the president directly by popular vote",
      ],
      "Anti-Federalists feared a strong central government with no written list of rights. Madison drafted the amendments, and the first ten were ratified in 1791. The Senate and the Electoral College stayed."
    ),
    mc(
      "c16",
      "A state sets its own requirements for a teaching license. The Constitution never mentions licenses. Which amendment best supports the state's power here?",
      ["the Tenth Amendment", "the First Amendment", "the Fifth Amendment", "the Second Amendment"],
      "The Tenth reserves to the states, or to the people, every power the Constitution does not give the federal government or deny the states. That is the federalism amendment on the review sheet. The First is speech, religion, press, assembly, and petition."
    ),
    tf(
      "c17",
      "In his Farewell Address (1796), Washington warned Americans against political parties and against permanent alliances with foreign nations.",
      true,
      "Both warnings are in the Farewell. The Neutrality Proclamation is the earlier document, from 1793, that kept the country out of the war between Britain and France."
    ),
    mc(
      "c18",
      "Historians call Jefferson's victory in 1800 a \"revolution\" mainly because",
      [
        "power passed peacefully from one party to its rival",
        "the army forced John Adams to leave the capital",
        "it was the first election with a popular vote for senators",
        "Jefferson won after the Federalists dissolved their party",
      ],
      "Adams, a Federalist, handed power to Jefferson, a Democratic-Republican, with no violence. Jefferson tied Burr in the Electoral College and the House chose Jefferson, which led to the 12th Amendment. State legislatures picked senators until 1913."
    ),
    mc(
      "c19",
      "Jefferson argued that Hamilton's national bank was unconstitutional because",
      [
        "the Constitution did not list a power to charter a bank",
        "the bank would be owned and run by the British crown",
        "Article I bans Congress from collecting any tariffs",
        "the Bill of Rights forbids any national debt",
      ],
      "Jefferson read the Constitution strictly. Hamilton answered with the necessary and proper clause, the loose reading. The bank sat in Hamilton's plan next to federal assumption of state debts, a tariff, and an excise tax."
    ),
    mc(
      "c20",
      "Napoleon agreed to sell Louisiana to the United States in 1803 mainly because",
      [
        "the Haitian Revolution ruined his plans and he needed money",
        "Spain refused to give the territory back to France",
        "the Monroe Doctrine had already closed the Americas to France",
        "American troops had already seized New Orleans",
      ],
      "Enslaved people in Saint-Domingue won the Haitian Revolution (1791 to 1804), which killed Napoleon's plan for an empire in the Americas. He needed money for war in Europe, so he sold all of it for $15 million. Spain had already handed Louisiana back to France in 1800. The Monroe Doctrine is 1823."
    ),
    mc(
      "c21",
      "Under the Missouri Compromise, slavery was banned in",
      [
        "the rest of the Louisiana Purchase north of 36°30′",
        "all the land the United States later took from Mexico",
        "every territory north of the Ohio River",
        "Missouri, in exchange for admitting Maine",
      ],
      "Missouri came in as a slave state and Maine as a free state. The rest of the Purchase north of 36°30′ was closed to slavery. The Ohio River ban is the Northwest Ordinance of 1787. No law closed all the Mexican Cession to slavery. That fight led to the Compromise of 1850."
    ),
    mc(
      "c22",
      "The Mexican-American War began in 1846 after",
      [
        "Polk sent troops into land Texas and Mexico both claimed",
        "Mexico tried to seize Florida back from the United States",
        "Britain and Mexico signed an alliance to seize Oregon",
        "Texas declared independence from the United States",
      ],
      "Texas was annexed in 1845. The United States said the border was the Rio Grande. Mexico said it was the Nueces River, farther north. Polk sent Zachary Taylor's army into the strip between them, the two armies clashed, and Polk asked Congress for war."
    ),
    mc(
      "c23",
      "Many northern Whigs and abolitionists opposed the Mexican-American War because they believed it",
      [
        "would add new territory where slavery could spread",
        "would violate the alliance the U.S. had signed with Mexico",
        "would force the United States to give Oregon to Britain",
        "was a plan to end slavery without a vote of Congress",
      ],
      "Critics called it a war for the slave power. Congressman Abraham Lincoln demanded that Polk name the exact spot where American blood was shed, and Thoreau went to jail rather than pay a tax that supported the war."
    ),
    mc(
      "c24",
      "In the Treaty of Guadalupe Hidalgo (1848), Mexico",
      [
        "ceded the Southwest and accepted the Rio Grande border",
        "sold Florida to the United States for $5 million",
        "agreed to split Oregon with the U.S. at the 49th parallel",
        "kept Texas but gave up its claims to California",
      ],
      "Mexico gave up the Mexican Cession, California through New Mexico, and accepted the Rio Grande as the Texas border. The United States paid $15 million. Florida came from Spain in 1819. Oregon was split with Britain, not Mexico, in 1846."
    ),
    tf(
      "c25",
      "The Compromise of 1850 admitted California as a free state and included a stronger Fugitive Slave Act.",
      true,
      "California entered free. Utah and New Mexico would decide slavery by popular sovereignty. The slave trade, not slavery itself, ended in Washington, D.C. The new Fugitive Slave Act made northerners help return people who escaped."
    ),
    tf(
      "c26",
      "In the 1820s and 1830s, most workers in the Lowell textile mills were immigrant men from Ireland.",
      false,
      "Most early Lowell workers were young unmarried women from New England farms, housed in company boardinghouses. Irish immigrants filled the mills later, in the 1840s and 1850s. The power looms ran on cotton grown by enslaved people in the South."
    ),
    tf(
      "c27",
      "The Declaration of Sentiments, adopted at Seneca Falls in 1848, borrowed the form of the Declaration of Independence and demanded the vote for women.",
      true,
      "Elizabeth Cady Stanton wrote it, with Lucretia Mott as a lead organizer. It opens \"all men and women are created equal\" and lists grievances the way Jefferson listed the king's. Susan B. Anthony joined the movement after the convention."
    ),
    mc(
      "c28",
      "After the cotton gin (1793) and the ban on slave imports (1808), the enslaved population of the Deep South grew mainly through",
      [
        "sales from the Upper South and natural population growth",
        "new shipments from Africa allowed under the 1808 law",
        "migration of free Black families from northern states",
        "the capture of Native Americans in Florida and Texas",
      ],
      "The gin made short-staple cotton pay inland, so slavery spread into Alabama, Mississippi, and Louisiana. With imports banned, about a million enslaved people were sold or moved south, and families were split apart. Most white southern families enslaved no one, but planters ran southern politics."
    ),
    mc(
      "c29",
      "Which act of resistance killed dozens of white Virginians in 1831 and led southern states to pass harsher slave codes?",
      ["Nat Turner's Rebellion", "Gabriel's Conspiracy", "Denmark Vesey's plot", "Shays' Rebellion"],
      "Nat Turner led the 1831 revolt in Southampton County, Virginia. Gabriel's conspiracy near Richmond (1800) and Denmark Vesey's plot in Charleston (1822) were betrayed before they began. Shays' Rebellion was Massachusetts farmers in 1786."
    ),
    mc(
      "c30",
      "Frederick Douglass is best known in the reform era as",
      [
        "a formerly enslaved writer and speaker for abolition",
        "the founder of the American Colonization Society",
        "a leader of the temperance movement in New England",
        "a Virginia planter who freed his slaves in his will",
      ],
      "Douglass escaped slavery in Maryland in 1838, published his Narrative in 1845, and spoke against slavery across the North and in Britain. He also went to Seneca Falls and backed the women's suffrage resolution."
    ),
  ];

  const maps = [
    {
      id: "a",
      title: "Map A",
      img: BASE + "map-a.svg",
      alt: "Map of the thirteen British colonies, each with a number",
      intro: "Questions 31 to 33 refer to Map A.",
      questions: [
        mc(
          "m01",
          "Which number marks the colony that held both Plymouth, founded by the Pilgrims in 1620, and the Puritan settlement John Winthrop led in 1630?",
          ["Colony 6", "Colony 9", "Colony 2", "Colony 11"],
          "Colony 6 is Massachusetts. Plymouth and Massachusetts Bay both sat inside it, and Plymouth was folded into Massachusetts in 1691. Maine, shaded the same color, was part of Massachusetts too. 9 is Rhode Island, 2 is Connecticut, 11 is New Hampshire."
        ),
        mc(
          "m02",
          "Which two numbers mark the Chesapeake colonies, where tobacco and indentured servants shaped early settlement?",
          ["Colonies 3 and 12", "Colonies 7 and 10", "Colonies 8 and 5", "Colonies 4 and 13"],
          "3 is Virginia and 12 is Maryland, the two colonies around the Chesapeake Bay. 7 and 10 are the Carolinas, in the Southern colonies. 8 and 5 are Pennsylvania and Delaware, and 4 and 13 are New York and New Jersey. Those four are Middle colonies."
        ),
        mc(
          "m03",
          "The colony labeled 10 grew rice and indigo, and by the early 1700s enslaved Africans were a majority of its people. Which colony is it?",
          ["South Carolina", "North Carolina", "Georgia", "Virginia"],
          "South Carolina sits between North Carolina (7) and Georgia (1). Rice planting there depended on enslaved Africans, many of whom already knew how to grow rice, and they outnumbered white colonists by about 1708."
        ),
      ],
    },
    {
      id: "b",
      title: "Map B",
      img: BASE + "map-b.svg",
      alt: "Map of United States territorial growth with six regions lettered A through F",
      intro: "Questions 34 to 38 refer to Map B.",
      questions: [
        mc(
          "m04",
          "Which letter marks the land the United States bought from France in 1803?",
          ["Region F", "Region B", "Region D", "Region E"],
          "F is the Louisiana Purchase, from the Mississippi to the Rockies. B is the Mexican Cession, D is the 1783 country, and E is Oregon."
        ),
        mc(
          "m05",
          "Region A came to the United States from",
          [
            "Spain, in the Adams-Onis Treaty of 1819",
            "France, in the Louisiana Purchase of 1803",
            "Britain, in the Treaty of Paris of 1783",
            "Mexico, in the Treaty of Guadalupe Hidalgo",
          ],
          "Region A is Florida. John Quincy Adams negotiated it with Spain in 1819. The same treaty drew the western border of the Louisiana Purchase."
        ),
        mc(
          "m06",
          "Which letter marks the independent republic the United States annexed in 1845, setting up the border dispute with Mexico?",
          ["Region C", "Region B", "Region F", "Region A"],
          "C is Texas. It won independence from Mexico in 1836 and was annexed in 1845. Mexico never accepted the Rio Grande border, and the fight over that strip started the war in 1846."
        ),
        mc(
          "m07",
          "Region B became part of the United States through",
          ["the Treaty of Guadalupe Hidalgo", "the Oregon Treaty with Britain", "the Adams-Onis Treaty with Spain", "the Louisiana Purchase from France"],
          "B is the Mexican Cession, which Mexico gave up at the end of the war in 1848. The Oregon Treaty (1846) is region E, split with Britain at the 49th parallel. The strip below B on the map is the Gadsden Purchase of 1853."
        ),
        mc(
          "m08",
          "The western edge of region D runs along the Mississippi River. That border was first set by",
          [
            "the Treaty of Paris (1783)",
            "the Proclamation of 1763",
            "the Northwest Ordinance (1787)",
            "the Louisiana Purchase (1803)",
          ],
          "Britain recognized independence in 1783 and gave up the land to the Mississippi. The Proclamation line ran along the Appalachians, far east of the river, and it died with British rule. The Northwest Ordinance organized land inside D. It did not set D's edge."
        ),
      ],
    },
    {
      id: "c",
      title: "Map C",
      img: BASE + "map-c.svg",
      alt: "Map of free states, slave states, and territories at one moment, with one state starred",
      intro: "Questions 39 and 40 refer to Map C.",
      questions: [
        mc(
          "m09",
          "Based on your understanding of territorial expansion and the balance of free and slave states, what year does this map represent?",
          ["1821", "1812", "1803", "1848"],
          "Missouri is a slave state and Maine a free state, so it is after the Missouri Compromise. Florida is a U.S. territory, so it is after Adams-Onis. Texas and the Southwest still belong to Mexico, so it is before 1845. Twelve free states and twelve slave states."
        ),
        mc(
          "m10",
          "The starred state entered the Union in 1820. How did it enter?",
          [
            "as a free state, balanced by Missouri as a slave state",
            "as a slave state, balanced by Missouri as a free state",
            "as a free state carved from the Louisiana Purchase",
            "as a slave state chosen by popular sovereignty",
          ],
          "The star is on Maine, which had been part of Massachusetts. It came in free so Missouri could come in slave and the Senate would stay even. Popular sovereignty is the later idea from the 1850 compromise."
        ),
      ],
    },
  ];

  const clusters = [
    {
      id: "polk",
      intro: "Questions 41 to 44 refer to the excerpt below.",
      text:
        "\"The cup of forbearance had been exhausted even before the recent information from the frontier of the Del Norte. But now, after reiterated menaces, Mexico has passed the boundary of the United States, has invaded our territory and shed American blood upon the American soil. She has proclaimed that hostilities have commenced, and that the two nations are now at war.\"",
      cite: "James K. Polk, message to Congress, May 11, 1846",
      questions: [
        mc(
          "p01",
          "Polk's claim that Mexico \"passed the boundary of the United States\" depended on the view that",
          [
            "the Rio Grande, not the Nueces, was the Texas border",
            "the Adams-Onis Treaty had made Texas part of the U.S.",
            "the Louisiana Purchase reached as far as California",
            "Mexico had agreed to sell its northern provinces",
          ],
          "The Del Norte is the Rio Grande. Mexico put the border at the Nueces. The fighting happened in the land between the two rivers, so whether it was American soil was the whole question. Adams-Onis actually left Texas with Spain."
        ),
        mc(
          "p02",
          "The excerpt was written in response to",
          [
            "a clash of U.S. and Mexican troops in disputed land",
            "Mexico's refusal to sell Oregon to the United States",
            "Britain's attempt to annex the Republic of Texas",
            "a slave revolt along the Texas and Louisiana border",
          ],
          "Mexican cavalry attacked a U.S. patrol north of the Rio Grande in April 1846. Polk used it to ask Congress for war. Oregon was a British question, settled the same year by treaty."
        ),
        mc(
          "p03",
          "The war that followed most directly resulted in",
          [
            "the Mexican Cession and a fight over slavery there",
            "the purchase of Florida and the Gulf Coast from Spain",
            "the end of the Missouri Compromise line in Louisiana",
            "a permanent alliance between the U.S. and Britain",
          ],
          "The 1848 treaty added the Mexican Cession, and Congress then fought over whether slavery could go there. The Compromise of 1850 was the result. Florida was 1819."
        ),
        mc(
          "p04",
          "Polk's message is most consistent with which idea of the 1840s?",
          ["Manifest Destiny", "Popular sovereignty", "Strict construction", "Immediate abolition"],
          "Manifest Destiny was the belief that the United States was meant to spread across the continent. Polk ran on it in 1844. Popular sovereignty is letting settlers vote on slavery. Strict construction is Jefferson's reading of the Constitution. Immediate abolition is Garrison."
        ),
      ],
    },
    {
      id: "garrison",
      intro: "Questions 45 to 48 refer to the excerpt below.",
      text:
        "\"Assenting to the 'self-evident truth' maintained in the American Declaration of Independence, 'that all men are created equal' . . . I shall strenuously contend for the immediate enfranchisement of our slave population. . . . In Park-street Church, on the Fourth of July, 1829, in an address on slavery, I unreflectingly assented to the popular but pernicious doctrine of gradual abolition. I seize this moment to make a full and unequivocal recantation. . . . I am aware, that many object to the severity of my language; but is there not cause for severity? I will be as harsh as truth, and as uncompromising as justice.\"",
      cite: "William Lloyd Garrison, \"To the Public,\" The Liberator, January 1, 1831",
      questions: [
        mc(
          "p05",
          "The \"popular but pernicious doctrine of gradual abolition\" that Garrison rejects was most closely tied to",
          [
            "the American Colonization Society",
            "the Seneca Falls women's rights convention",
            "the Northwest Ordinance of 1787",
            "the temperance campaign against alcohol",
          ],
          "The American Colonization Society, founded in 1816, paired slow emancipation with sending free Black Americans to Africa, which produced Liberia. Garrison had once accepted gradualism and here takes it back."
        ),
        mc(
          "p06",
          "Garrison's position differed from the American Colonization Society's because he",
          [
            "wanted slavery ended now, with freed people staying here",
            "wanted freed people sent to Liberia once slavery ended",
            "wanted each state to end slavery at its own pace",
            "wanted enslavers paid before anyone was freed",
          ],
          "Immediatism means freedom now, in the United States. Sending people to Liberia is the society's plan. A state-by-state pace and paying enslavers first are both versions of the gradualism he is rejecting."
        ),
        mc(
          "p07",
          "Garrison started The Liberator in the same year as",
          [
            "Nat Turner's revolt in Virginia",
            "the Seneca Falls Convention",
            "the Missouri Compromise",
            "the Treaty of Guadalupe Hidalgo",
          ],
          "The first issue is January 1, 1831. Turner's revolt was that August, and Virginia blamed abolitionist writing for it. Seneca Falls is 1848, Missouri 1820, Guadalupe Hidalgo 1848."
        ),
        mc(
          "p08",
          "Garrison's appeal to the Declaration of Independence is most similar to the argument of",
          [
            "the Declaration of Sentiments",
            "Washington's Farewell Address",
            "the Proclamation of 1763",
            "the Monroe Doctrine",
          ],
          "Both take Jefferson's \"all men are created equal\" and hold the country to it. Garrison uses it for enslaved people. Seneca Falls rewrote it as \"all men and women.\""
        ),
      ],
    },
    {
      id: "farewell",
      intro: "Questions 49 and 50 refer to the excerpt below.",
      text:
        "\"The great rule of conduct for us in regard to foreign nations is in extending our commercial relations, to have with them as little political connection as possible. . . . Europe has a set of primary interests which to us have none; or a very remote relation. Hence she must be engaged in frequent controversies, the causes of which are essentially foreign to our concerns. . . . It is our true policy to steer clear of permanent alliances with any portion of the foreign world.\"",
      cite: "George Washington, Farewell Address, 1796",
      questions: [
        mc(
          "p09",
          "Washington's advice is most consistent with which later policy?",
          [
            "the Monroe Doctrine (1823)",
            "the Louisiana Purchase (1803)",
            "the Mexican-American War (1846)",
            "the Missouri Compromise (1820)",
          ],
          "Monroe told Europe to stay out of the Americas and promised the United States would stay out of Europe's wars. That is Washington's separation of American and European affairs, applied to a whole hemisphere."
        ),
        mc(
          "p10",
          "Which earlier step followed the same principle as the excerpt?",
          [
            "the Neutrality Proclamation of 1793",
            "the alliance with France in 1778",
            "the Proclamation Line of 1763",
            "the Bank of the United States in 1791",
          ],
          "In 1793 Washington kept the country out of the war between Britain and France. The 1778 French alliance is the kind of permanent tie the Farewell warns against. The 1763 line was British, and the bank is domestic policy."
        ),
      ],
    },
  ];

  const bonus = [
    mc(
      "b01",
      "Finished in 1825, the Erie Canal connected",
      [
        "the Great Lakes to the Hudson River and New York City",
        "the Ohio River to the Gulf of Mexico at New Orleans",
        "the Chesapeake Bay to the Delaware River and Philadelphia",
        "Lake Michigan to the Mississippi River at St. Louis",
      ],
      "The canal ran across New York from Buffalo on Lake Erie to Albany on the Hudson. Freight costs from the West fell sharply and New York City became the country's biggest port. It belongs with the telegraph on the Market Revolution list."
    ),
  ];

  const count =
    content.length +
    maps.reduce((n, m) => n + m.questions.length, 0) +
    clusters.reduce((n, c) => n + c.questions.length, 0) +
    bonus.length;

  return {
    quizId: "us-history-fall-final-3",
    total: count,
    content,
    maps,
    clusters,
    bonus,
  };
}

async function sendHistoryFinal3(req, res) {
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

module.exports = { sendHistoryFinal3, quizPayload, ALLOWED };
