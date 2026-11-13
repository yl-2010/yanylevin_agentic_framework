/**
 * Fall US History final practice. Questions stay off the public page.
 * Only Yan and Alex's Google sessions get the payload.
 */

const { readSession } = require("./_auth");

const ALLOWED = new Set(["you@example.com", "you@example.com"]);

function mc(id, stem, choices, answer, why) {
  return { id, kind: "mc", stem, choices, answer, why };
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
    '<svg viewBox="0 0 680 460" role="img" aria-label="Schematic of the British mainland colonies">' +
    '<rect width="680" height="460" fill="#e7e1d6"/>' +
    '<rect x="36" y="36" width="250" height="388" fill="#d3cbbd"/>' +
    '<text x="161" y="210" text-anchor="middle" font-family="Karla, sans-serif" font-size="15" fill="#3a342c">West of the</text>' +
    '<text x="161" y="232" text-anchor="middle" font-family="Karla, sans-serif" font-size="15" fill="#3a342c">Appalachians</text>' +
    '<line x1="300" y1="36" x2="300" y2="424" stroke="#3a342c" stroke-width="2" stroke-dasharray="6 5"/>' +
    '<text x="300" y="24" text-anchor="middle" font-family="Karla, sans-serif" font-size="13" fill="#3a342c">1763 line</text>' +
    '<rect x="314" y="36" width="250" height="78" fill="#8eae86"/>' +
    '<text x="439" y="68" text-anchor="middle" font-family="Karla, sans-serif" font-size="16" font-weight="700" fill="#1c2418">New England</text>' +
    '<text x="439" y="90" text-anchor="middle" font-family="Karla, sans-serif" font-size="13" fill="#1c2418">Boston</text>' +
    '<rect x="314" y="122" width="250" height="78" fill="#d2b072"/>' +
    '<text x="439" y="154" text-anchor="middle" font-family="Karla, sans-serif" font-size="16" font-weight="700" fill="#2a2114">Middle colonies</text>' +
    '<text x="439" y="176" text-anchor="middle" font-family="Karla, sans-serif" font-size="13" fill="#2a2114">New York · Philadelphia</text>' +
    '<rect x="314" y="208" width="250" height="90" fill="#c4784e"/>' +
    '<text x="439" y="244" text-anchor="middle" font-family="Karla, sans-serif" font-size="16" font-weight="700" fill="#2a140e">Chesapeake</text>' +
    '<text x="439" y="266" text-anchor="middle" font-family="Karla, sans-serif" font-size="13" fill="#2a140e">Virginia · Maryland</text>' +
    '<text x="439" y="284" text-anchor="middle" font-family="Karla, sans-serif" font-size="13" fill="#2a140e">tobacco</text>' +
    '<rect x="314" y="306" width="250" height="118" fill="#8d4548"/>' +
    '<text x="439" y="348" text-anchor="middle" font-family="Karla, sans-serif" font-size="16" font-weight="700" fill="#fff6f4">Lower South</text>' +
    '<text x="439" y="370" text-anchor="middle" font-family="Karla, sans-serif" font-size="13" fill="#fff6f4">Charleston</text>' +
    '<text x="439" y="390" text-anchor="middle" font-family="Karla, sans-serif" font-size="13" fill="#fff6f4">rice and indigo</text>' +
    '<text x="620" y="230" text-anchor="middle" font-family="Karla, sans-serif" font-size="14" fill="#2c4a5c" transform="rotate(90 620 230)">Atlantic</text>' +
    '<text x="48" y="58" font-family="Karla, sans-serif" font-size="13" fill="#3a342c">N</text>' +
    "</svg>"
  );
}

function mapB() {
  return (
    '<svg viewBox="0 0 720 420" role="img" aria-label="Schematic of the United States after independence">' +
    '<rect width="720" height="420" fill="#e7e1d6"/>' +
    '<rect x="28" y="48" width="250" height="250" fill="#9bb7c9"/>' +
    '<text x="153" y="150" text-anchor="middle" font-family="Karla, sans-serif" font-size="16" font-weight="700" fill="#142028">United States</text>' +
    '<text x="153" y="174" text-anchor="middle" font-family="Karla, sans-serif" font-size="14" fill="#142028">1783</text>' +
    '<text x="153" y="198" text-anchor="middle" font-family="Karla, sans-serif" font-size="13" fill="#142028">Atlantic to the</text>' +
    '<text x="153" y="216" text-anchor="middle" font-family="Karla, sans-serif" font-size="13" fill="#142028">Mississippi</text>' +
    '<rect x="28" y="248" width="250" height="50" fill="#c4784e"/>' +
    '<text x="153" y="278" text-anchor="middle" font-family="Karla, sans-serif" font-size="14" font-weight="700" fill="#2a140e">Upper South</text>' +
    '<rect x="292" y="48" width="300" height="250" fill="#d2b072"/>' +
    '<text x="442" y="130" text-anchor="middle" font-family="Karla, sans-serif" font-size="16" font-weight="700" fill="#2a2114">Louisiana Purchase</text>' +
    '<text x="442" y="154" text-anchor="middle" font-family="Karla, sans-serif" font-size="14" fill="#2a2114">1803</text>' +
    '<line x1="292" y1="168" x2="592" y2="168" stroke="#3a342c" stroke-width="2" stroke-dasharray="6 5"/>' +
    '<text x="442" y="190" text-anchor="middle" font-family="Karla, sans-serif" font-size="13" fill="#2a2114">1820 line</text>' +
    '<rect x="292" y="248" width="300" height="50" fill="#8d4548"/>' +
    '<text x="442" y="278" text-anchor="middle" font-family="Karla, sans-serif" font-size="14" font-weight="700" fill="#fff6f4">Cotton belt</text>' +
    '<rect x="606" y="300" width="86" height="70" fill="#8eae86"/>' +
    '<text x="649" y="332" text-anchor="middle" font-family="Karla, sans-serif" font-size="13" font-weight="700" fill="#1c2418">Florida</text>' +
    '<text x="649" y="350" text-anchor="middle" font-family="Karla, sans-serif" font-size="12" fill="#1c2418">1819</text>' +
    '<text x="28" y="36" font-family="Karla, sans-serif" font-size="13" fill="#3a342c">N</text>' +
    "</svg>"
  );
}

function quizPayload() {
  const content = [
    mc(
      "c01",
      "The first permanent English settlement in what became the United States was",
      [
        "Jamestown, founded in Virginia in 1607",
        "Plymouth, founded by Separatists in 1620",
        "Roanoke, the colony Raleigh planted in the 1580s",
        "Massachusetts Bay, founded by Winthrop in 1630",
      ],
      0,
      "Jamestown is the one that lasted. Roanoke disappeared. Plymouth and Massachusetts Bay came later."
    ),
    mc(
      "c02",
      "Through most of the 1600s, tobacco planters in Virginia filled field labor mainly with",
      [
        "enslaved Africans brought in under the Royal African Company from the start",
        "indentured servants, with slavery becoming the main system later in the century",
        "wage workers hired off ships in Boston each spring",
        "Native people captured under the headright system and held for life",
      ],
      1,
      "Early Chesapeake labor was mostly indentured servants. Lifetime racial slavery hardened after the mid-1600s, especially once Bacon's Rebellion shook the colony."
    ),
    tf(
      "c03",
      "The Mayflower Compact was the royal charter that created Massachusetts Bay Colony.",
      false,
      "The Compact was an agreement among the Separatists at Plymouth to form a civil government. Massachusetts Bay had its own charter, and Winthrop's colony is a different settlement."
    ),
    mc(
      "c04",
      "John Winthrop's \"city upon a hill\" line was meant to describe",
      [
        "a Puritan colony that would be a model Christian community",
        "a tobacco port whose wealth would fund the English crown",
        "Roger Williams's colony with no established church",
        "a Quaker refuge that refused to set up a militia",
      ],
      0,
      "The line is from Winthrop's 1630 lay sermon, A Model of Christian Charity, on the way to Massachusetts Bay. Rhode Island and Pennsylvania are different projects."
    ),
    mc(
      "c05",
      "Under mercantilism, the Navigation Acts tried to make sure that",
      [
        "colonial goods moved on English ships and through English ports",
        "every colony elected its own governor without a royal veto",
        "colonists could sell tobacco directly to French and Dutch buyers",
        "Parliament could not tax anything made inside a colony",
      ],
      0,
      "The idea was that the colonies feed the mother country. Trade was supposed to stay inside the English system."
    ),
    mc(
      "c06",
      "The Proclamation of 1763 told colonists they could not",
      [
        "settle west of the Appalachian crest",
        "import tea from the Dutch East India Company",
        "print newspapers without a royal stamp",
        "sit in juries if they had criticized the king",
      ],
      0,
      "Britain drew the line after the Seven Years' War and Pontiac's War. It was cheaper than guarding settlers in Indian country. The stamp, tea, and jury fights come later."
    ),
    mc(
      "c07",
      "The Stamp Act of 1765 was different from the later Townshend duties because the Stamp Act",
      [
        "taxed papers and documents inside the colonies, not goods at the dock",
        "banned newspapers that criticized the royal governor",
        "put a duty on tea only, and left every other import alone",
        "required colonists to quarter soldiers in their houses",
      ],
      0,
      "The Stamp Act was an internal tax on legal papers, newspapers, and dice. Townshend taxes were import duties on glass, lead, paper, paint, and tea. Quartering was a separate grievance."
    ),
    mc(
      "c08",
      "Thomas Paine's Common Sense, published in January 1776, argued that",
      [
        "hereditary monarchy was absurd and the colonies should declare independence",
        "the colonies should accept a stamp tax in exchange for seats in Parliament",
        "Washington should be crowned king once the British evacuated Boston",
        "reconciliation with George III was still the safest course",
      ],
      0,
      "Paine wrote in plain language for a wide audience and pushed independence months before the Declaration. He was not asking for a deal with Parliament."
    ),
    tf(
      "c09",
      "The American victory at Saratoga in 1777 helped convince France to ally with the United States.",
      true,
      "Saratoga showed France the rebellion could win. The treaty of alliance came in 1778. Yorktown still matters, but it comes after France is already in the war."
    ),
    mc(
      "c10",
      "Which result best fits the question \"a revolution for whom?\"",
      [
        "Northern states began ending slavery, the Lower South kept it, and women did not gain the vote",
        "Every state abolished slavery before the Constitution was written",
        "Married women gained the vote in every state that ratified the Constitution",
        "Loyalists kept their estates and sat in the new state legislatures",
      ],
      0,
      "Liberty widened for many white men. Pennsylvania's gradual emancipation law is 1780. The Lower South did not follow. Women did not get political rights, and many Loyalists lost property."
    ),
    mc(
      "c11",
      "A weakness of Congress under the Articles of Confederation was that it",
      [
        "could ask the states for money but could not levy a tax itself",
        "could not pass the Northwest Ordinance or organize western land",
        "held a permanent army larger than any state militia",
        "elected a president who served a single six-year term",
      ],
      0,
      "Requisitions depended on the states actually paying. The Northwest Ordinance was a success under the Articles. There was no separate national executive."
    ),
    mc(
      "c12",
      "Shays' Rebellion mattered to the men who called the Philadelphia convention because",
      [
        "armed farmers in Massachusetts made a weak central government look dangerous",
        "it forced Britain to return forts it still held in the Northwest",
        "it ended the slave trade inside Massachusetts that same winter",
        "it proved the Confederation Congress could tax and pay the army",
      ],
      0,
      "In 1786 and 1787, debt-ridden farmers shut courts and marched on the Springfield armory. Washington and others read it as a reason to build a stronger national government."
    ),
    mc(
      "c13",
      "The Great Compromise at the Constitutional Convention settled representation by",
      [
        "giving the House seats by population and giving each state two senators",
        "counting three fifths of enslaved people toward each state's House seats",
        "letting every state have the same number of seats in a one-house Congress",
        "letting the president appoint both houses for six-year terms",
      ],
      0,
      "That is the Connecticut Compromise. The three-fifths clause is a different fight, about who counts toward population. The New Jersey Plan wanted equal votes for states in one house."
    ),
    mc(
      "c14",
      "The three-fifths clause meant that",
      [
        "three fifths of the enslaved population counted toward House seats and direct taxes",
        "enslaved men could vote in federal elections if they paid a poll tax",
        "three fifths of the states had to agree before Congress could ban the slave trade",
        "each senator from a slave state cast three fifths of a vote",
      ],
      0,
      "It is Article I, Section 2. Enslaved people did not vote. The slave-trade delay until 1808 is a different clause, in Section 9."
    ),
    tf(
      "c15",
      "The Bill of Rights was already part of the Constitution signed at Philadelphia in 1787.",
      false,
      "The 1787 text had no list of rights. Several states ratified only after Federalists promised amendments. The first ten amendments were ratified in 1791."
    ),
    mc(
      "c16",
      "The Constitution gives the power to declare war to",
      [
        "Congress",
        "the president alone, as commander in chief",
        "the Supreme Court, by a majority of the justices",
        "a council of state governors",
      ],
      0,
      "Article I gives Congress the power to declare war. The president commands the forces once they exist. That split is the one the judicial-branch notes hammer."
    ),
    mc(
      "c17",
      "A pocket veto is different from a regular veto because",
      [
        "the bill dies when Congress adjourns, and Congress cannot override it",
        "two thirds of the Senate alone can revive the bill",
        "the Supreme Court has to sign the bill before it dies",
        "it only applies to constitutional amendments, not to statutes",
      ],
      0,
      "If Congress is still in session, silence for ten days makes the bill law. If Congress has adjourned, silence kills it. A regular veto can be overridden by two thirds of both houses."
    ),
    mc(
      "c18",
      "Marbury v. Madison (1803) is the case in which the Supreme Court",
      [
        "claimed the power to strike down a federal law that conflicts with the Constitution",
        "upheld the Alien and Sedition Acts as a war power",
        "ordered President Jackson to enforce Worcester v. Georgia",
        "ruled that states could nullify a federal tariff",
      ],
      0,
      "Marshall refused to order delivery of Marbury's commission and, in the same opinion, said the Court can review acts of Congress. The Constitution never uses the phrase judicial review."
    ),
    mc(
      "c19",
      "Alexander Hamilton's financial plan included",
      [
        "federal assumption of state debts, a national bank, and a tariff",
        "erasing the state debts and printing paper money with no bank",
        "moving the capital to New York in exchange for ending the tariff",
        "a tax on enslaved people that would fund gradual emancipation",
      ],
      0,
      "Assumption, the Bank of the United States, and tariff-and-excise revenue are the core. Jefferson fought the bank as not listed in the Constitution. The capital moved to the Potomac as part of the deal, not to New York."
    ),
    mc(
      "c20",
      "In the Farewell Address, Washington told the country to",
      [
        "avoid permanent alliances and resist the spirit of party",
        "join France's revolutionary wars to repay the 1778 treaty",
        "break the Union into three regional confederations",
        "let each state print its own currency again",
      ],
      0,
      "The 1796 address warns against permanent foreign alliances and against factions. The Neutrality Proclamation of 1793 is the earlier, related step. He did not tell Americans to fight for France."
    ),
    mc(
      "c21",
      "The Virginia and Kentucky Resolutions were written in response to",
      [
        "the Alien and Sedition Acts, and they claimed states could judge federal laws",
        "the Embargo Act, and they demanded war with Britain",
        "Marbury v. Madison, and they asked Marshall to resign",
        "the Louisiana Purchase, and they called the treaty unconstitutional",
      ],
      0,
      "In 1798 the Federalist Congress criminalized criticism of the government. Madison and Jefferson answered with the compact theory: the states created the Constitution and could call a federal law void. The embargo is Jefferson's later policy, in 1807."
    ),
    mc(
      "c22",
      "The election of 1800 mattered because",
      [
        "power passed from the Federalists to Jefferson's party without a coup",
        "Adams refused to leave office until the army removed him",
        "the House chose Aaron Burr and passed the 11th Amendment to stop it",
        "it was the first election in which senators were chosen by popular vote",
      ],
      0,
      "Jefferson and Burr tied in the electoral college. The House picked Jefferson. The mess pushed the 12th Amendment, ratified in 1804, so president and vice president are voted separately. Senators stayed chosen by state legislatures until the 20th century."
    ),
    mc(
      "c23",
      "Jefferson hesitated over the Louisiana Purchase because",
      [
        "a strict reading of the Constitution did not list a power to buy territory",
        "Spain refused to take the $15 million and demanded a war instead",
        "the Senate had no power to ratify any treaty",
        "Hamilton insisted the purchase would free every enslaved person there",
      ],
      0,
      "Napoleon's France sold the territory in 1803. Jefferson believed in a narrow reading of federal power, then took the deal anyway. The Senate does ratify treaties. Florida, from Spain, is the Adams-Onís Treaty in 1819."
    ),
    mc(
      "c24",
      "The Missouri Compromise of 1820 did all of the following except",
      [
        "ban slavery in every territory the United States would ever acquire",
        "admit Missouri as a slave state",
        "admit Maine as a free state",
        "ban slavery in the Louisiana Purchase north of 36°30', except in Missouri",
      ],
      0,
      "The line applied to the Louisiana Purchase lands, not to land the country did not yet hold. Maine balanced Missouri so the Senate stayed even. The Compromise of 1850 is a later, different bargain."
    ),
    mc(
      "c25",
      "The Erie Canal, finished in 1825, changed the market revolution by",
      [
        "linking the Great Lakes to the Hudson and pulling western trade through New York",
        "connecting the Mississippi to the Pacific on one federally built line",
        "replacing every turnpike in New England with a railroad",
        "shipping Lowell cloth south without using coastal packets",
      ],
      0,
      "The canal made New York the country's commercial city. A railroad to the Pacific is the transcontinental line, finished in 1869. Lowell cloth still moved by water and coastal ship."
    ),
    mc(
      "c26",
      "The mills at Waltham and Lowell are best described as",
      [
        "water-powered factories that hired young women from farm families and housed many of them",
        "plantations that paid enslaved spinners a wage and a garden plot",
        "the shops where Eli Whitney built the cotton gin in 1793",
        "federal armories that made muskets only for the War of 1812",
      ],
      0,
      "Francis Cabot Lowell's Boston associates put the power loom at Waltham in 1814, then built Lowell on the Merrimack. The boardinghouse system was how they got farm parents to let daughters leave home. Whitney's gin is a different machine, in Georgia."
    ),
    mc(
      "c27",
      "The cotton gin changed slavery because it",
      [
        "made short-staple cotton profitable across the Deep South and raised the demand for enslaved labor",
        "let planters harvest cotton without field workers",
        "ended the need for the domestic slave trade after 1808",
        "shifted the main cotton crop from the South to New England family farms",
      ],
      0,
      "Whitney's gin, 1793, cleaned the seeds out of short-staple cotton. That spread cotton, and slavery, inland. It did not shrink the labor force."
    ),
    tf(
      "c28",
      "After the international slave trade closed in 1808, a domestic trade carried enslaved people from the Upper South into the cotton states.",
      true,
      "The Constitution barred Congress from ending the import trade before 1808. Once imports were illegal, the Upper South sold people south to Georgia, Alabama, Mississippi, and Louisiana."
    ),
    tf(
      "c29",
      "Most white households in the South enslaved people.",
      false,
      "Slaveholding families were a minority of white households. Planters still dominated southern politics, and the system shaped people who enslaved no one."
    ),
    mc(
      "c30",
      "After Worcester v. Georgia (1832) said the Cherokee were a distinct nation, Andrew Jackson",
      [
        "did not enforce the ruling, and removal went ahead on the Trail of Tears",
        "sent the army to stop Georgia from touching Cherokee land",
        "asked Congress to repeal the Indian Removal Act of 1830",
        "offered the Cherokee seats in the House under the three-fifths rule",
      ],
      0,
      "Marshall's Court sided with the Cherokee. Jackson would not carry the decision out. The Removal Act was already law. Forced removal followed, including the Trail of Tears in 1838 under Van Buren."
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
        "region west of the 1763 line",
      ],
      0,
      "Virginia and Maryland grew tobacco with bound labor. New England is towns and small farms. The middle colonies are the wheat and port region. West of the line is not a tobacco coast."
    ),
    mc(
      "m02",
      "Boston is marked in New England. That region's ordinary settlement was",
      [
        "towns of small farms and a Puritan church, not staple plantations",
        "rice plantations worked by task labor along the coast",
        "a single royal plantation owned by the Baltimore family",
        "gold mines claimed under the headright system",
      ],
      0,
      "New England's economy was mixed farming, timber, fish, and trade. Rice and the task system belong to the Lower South on this map. Baltimore's grant is Maryland."
    ),
    mc(
      "m03",
      "Philadelphia is marked with the middle colonies. Those colonies were known for",
      [
        "wheat farming, busy ports, and a mix of religions and ethnic groups",
        "the Puritan requirement that every voter be a full church member",
        "rice as the only legal export under the Navigation Acts",
        "a ban on all port cities so trade stayed inland",
      ],
      0,
      "Pennsylvania, New York, and New Jersey drew Quakers, Dutch, Germans, and others. Church membership as a voting rule is Massachusetts Bay. Rice is the Lower South."
    ),
    mc(
      "m04",
      "The dashed 1763 line on map A is the Proclamation line. Colonists were told to stay",
      [
        "east of it",
        "west of it, and leave the coast to the army",
        "south of Charleston only",
        "inside New England until the Stamp Act expired",
      ],
      0,
      "The Appalachian line was the western edge of legal settlement. Land speculators and squatters hated it. The ocean, and the Atlantic label, is the other direction."
    ),
    mc(
      "m05",
      "Charleston sits in the Lower South block, whose staple labels are rice and indigo. Those crops depended on",
      [
        "enslaved labor, including a task system in the rice fields",
        "free family labor of the same kind as a New England town",
        "indentured servants who all went home to England after four years",
        "wage hands recruited from Lowell boardinghouses",
      ],
      0,
      "Rice swamps in South Carolina and Georgia were deadly work. Planters used enslaved labor, often by the task. Lowell is a later New England factory system, not this coast."
    ),
    mc(
      "m06",
      "On map B, the Louisiana Purchase block was sold to the United States by",
      [
        "France",
        "Spain",
        "Britain",
        "Mexico",
      ],
      0,
      "Napoleon sold it in 1803. Spain had held it earlier and got it back on paper for a moment, but the seller in 1803 was France. Florida, the small block, is the Spanish cession."
    ),
    mc(
      "m07",
      "The dashed 1820 line across the Louisiana Purchase is the Missouri Compromise line. It",
      [
        "banned slavery north of that line in the Purchase, except inside Missouri",
        "banned slavery in Missouri itself and made Maine a slave state",
        "set the western border of the United States at the Mississippi",
        "opened the international slave trade for another twenty years",
      ],
      0,
      "Missouri entered as a slave state, Maine as a free state, and the rest of the Purchase north of 36°30' was closed to slavery. The Mississippi border is the 1783 block. The import trade had already closed in 1808."
    ),
    mc(
      "m08",
      "The Florida block, dated 1819, came to the United States from Spain by the",
      [
        "Adams-Onís Treaty",
        "Treaty of Paris",
        "Louisiana Purchase",
        "Missouri Compromise",
      ],
      0,
      "John Quincy Adams negotiated the Adams-Onís Treaty. The Treaty of Paris is 1783. Louisiana was the French sale. The Missouri Compromise drew a slavery line. It did not buy Florida."
    ),
    mc(
      "m09",
      "The 1783 block stops at the Mississippi. That western border was set by the",
      [
        "Treaty of Paris, which ended the Revolutionary War",
        "Proclamation of 1763, which Britain never repealed",
        "Adams-Onís Treaty with Spain",
        "Monroe Doctrine",
      ],
      0,
      "Britain recognized independence and ceded to the Mississippi. The Proclamation line was the Appalachians, and independence wiped that British rule out. The Monroe Doctrine is 1823 foreign policy, not a border treaty."
    ),
    mc(
      "m10",
      "Map B labels a cotton belt across the Deep South and an Upper South above it. After 1808, the domestic slave trade moved people mainly",
      [
        "from the Upper South toward the cotton belt",
        "from the cotton belt back to New England mill towns",
        "from Florida into the Louisiana Purchase north of the 1820 line",
        "from Boston south along the 1763 proclamation line",
      ],
      0,
      "The Upper South, especially Virginia and Maryland, sold people into Alabama, Mississippi, Louisiana, and the rest of the cotton kingdom. The 1820 line was supposed to keep slavery out of the northern Purchase. It did not stop the trade into the cotton states."
    ),
  ];

  const sources = [
    {
      id: "declaration",
      title: "Source A. Declaration of Independence, 1776",
      text:
        "We hold these truths to be self-evident, that all men are created equal, that they are endowed by their Creator with certain unalienable Rights, that among these are Life, Liberty and the pursuit of Happiness. That to secure these rights, Governments are instituted among Men, deriving their just powers from the consent of the governed. That whenever any Form of Government becomes destructive of these ends, it is the Right of the People to alter or to abolish it, and to institute new Government.",
    },
    {
      id: "farewell",
      title: "Source B. Washington, Farewell Address, 1796",
      text:
        "Let me warn you in the most solemn manner against the baneful effects of the spirit of party. The great rule of conduct for us in regard to foreign nations is, in extending our commercial relations, to have with them as little political connection as possible. It is our true policy to steer clear of permanent alliances with any portion of the foreign world.",
    },
    {
      id: "garrison",
      title: "Source C. William Lloyd Garrison, The Liberator, 1831",
      text:
        "I am aware that many object to the severity of my language; but is there not cause for severity? I will be as harsh as truth, and as uncompromising as justice. On this subject, I do not wish to think, or speak, or write, with moderation. I am in earnest. I will not equivocate. I will not excuse. I will not retreat a single inch. And I will be heard.",
    },
  ];

  const primary = [
    mc(
      "p01",
      "In source A, \"deriving their just powers from the consent of the governed\" is closest to",
      [
        "the claim that legitimate government rests on the people, not on a king's birth",
        "the divine right of kings as Filmer described it",
        "Parliament's theory that virtual representation already included the colonies",
        "the three-fifths rule for counting enslaved people",
      ],
      0,
      "Jefferson is using the liberal argument the class tagged in the British-traditions notes. Authority comes from consent. Divine right and virtual representation are the positions the Declaration is rejecting."
    ),
    mc(
      "p02",
      "The right to \"alter or to abolish\" a destructive government is there to justify",
      [
        "independence from Britain",
        "the later Bill of Rights, amendment by amendment",
        "Hamilton's bank as a necessary instrument",
        "the Northwest Ordinance's ban on slavery",
      ],
      0,
      "The paragraph is the Declaration's case for leaving the empire. Amendments, the bank, and the Ordinance are later documents."
    ),
    mc(
      "p03",
      "The main author of source A was",
      [
        "Thomas Jefferson",
        "Thomas Paine",
        "George Washington",
        "John Dickinson",
      ],
      0,
      "Congress edited Jefferson's draft. Paine wrote Common Sense. Washington commanded the army. Dickinson wrote Letters from a Farmer and then opposed the break."
    ),
    tf(
      "p04",
      "Source A immediately freed enslaved people in every state.",
      false,
      "The paragraph announces universal rights and then the new country did not apply them to enslaved people. Northern gradual emancipation came from state laws, not from this sentence."
    ),
    mc(
      "p05",
      "On foreign nations, source B tells the United States to",
      [
        "trade widely and avoid permanent alliances",
        "honor the 1778 French treaty by joining France's wars",
        "sign a permanent alliance with Britain against Spain",
        "close every port to foreign merchants",
      ],
      0,
      "Washington separates commerce from political ties. He does not want a permanent alliance with anyone. The Neutrality Proclamation had already kept the country out of France's war."
    ),
    mc(
      "p06",
      "\"The spirit of party\" in source B refers to",
      [
        "factions, including the Federalist and Republican split already underway",
        "the committees of correspondence in the 1760s",
        "the formal party platforms required by the Constitution",
        "state nominating conventions created by the 12th Amendment",
      ],
      0,
      "By 1796 the country already had Federalists and Democratic-Republicans. The Constitution does not set up parties. Washington thought they would tear the government apart."
    ),
    tf(
      "p07",
      "Source B is the Neutrality Proclamation of 1793.",
      false,
      "Both are Washington, and they point the same direction, but the Farewell Address is 1796, when he refused a third term. The Neutrality Proclamation is the 1793 statement that the country was staying out of the European war."
    ),
    mc(
      "p08",
      "Garrison's refusal to \"write with moderation\" means he wants",
      [
        "immediate abolition, with no apology for harsh language",
        "a slower plan that colonizes free Black people in Africa",
        "enslavers to be paid in full before anyone is freed",
        "the slave trade to stay open until the cotton gin wears out",
      ],
      0,
      "The Liberator's opening issue, January 1, 1831, is an immediatist manifesto. Colonization and compensation are the programs he is attacking, not the one he is announcing."
    ),
    mc(
      "p09",
      "Source C first appeared in",
      [
        "The Liberator, which Garrison started in Boston in 1831",
        "the Seneca Falls Declaration of Sentiments in 1848",
        "the American Colonization Society's pamphlet of 1816",
        "South Carolina's ordinance of nullification in 1832",
      ],
      0,
      "Garrison printed this in the first issue of The Liberator. Seneca Falls is the women's-rights convention. The Colonization Society is the gradual, send-them-to-Africa plan. Nullification is Calhoun's tariff fight."
    ),
    mc(
      "p10",
      "Set next to the American Colonization Society, Garrison's position was that slavery should",
      [
        "end now, in the United States, without shipping Black Americans to Africa as the plan",
        "end only after every enslaver was paid and every free person left for Liberia",
        "be left to each state, with no public criticism allowed",
        "expand west of the 1820 line so cotton could keep pace with the mills",
      ],
      0,
      "The Colonization Society, founded in 1816, paired gradual emancipation with removal to Africa. Garrison broke with that. He wanted slavery judged and ended here."
    ),
  ];

  const bonus = [
    mc(
      "b01",
      "Bonus. The Northwest Ordinance of 1787",
      [
        "banned slavery in the territory north of the Ohio River and set rules for new states",
        "banned slavery in the Southwest and opened the international slave trade",
        "gave every settler west of the Appalachians a seat in the Confederation Congress",
        "repealed the Proclamation of 1763 and returned the Ohio country to France",
      ],
      0,
      "The Ordinance is one of the Articles' real successes. It banned slavery north of the Ohio, promised support for schools, and laid out how a territory becomes a state. The 1763 line was a British rule, already dead by 1787."
    ),
  ];

  return {
    quizId: "us-history-fall-final",
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

async function sendHistoryFinal(req, res) {
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

module.exports = { sendHistoryFinal, quizPayload, ALLOWED };
