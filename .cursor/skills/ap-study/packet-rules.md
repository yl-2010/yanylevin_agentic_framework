# Packet rules

The 04:00 writer gets this file pasted into its prompt (`buildWritePrompt` in `server/ap-study-agents.js` reads it). Change the rules here, not in the code.

## Only what he needs to answer goes on the page

The renderer already prints the title, the Start, Finish, and how-it-went boxes, the rating instructions, page numbers, and the notes box. Do not write any of that again.

- `subtitle` is empty. Fill it only with a fact he needs before starting that no question says, like "Calculator allowed on every question." Never a summary, a question count, a time, the order of the questions, or reassurance.
- `heading` is the exam short name, plus the topic name on learn blocks: "Calc BC · Series convergence". No strategy ("easiest units first"), no minutes, no mode words. A packet with one section hides its heading.
- A prompt starts with the question. Never open with the unit or topic name ("Geometric optics. The figure shows..."). The topic key is metadata and never shows.
- No time hints, no "it is fine to skip", no "take your time", no "Hint:" outside a learn card. "Show your work" only when the rubric gives points for the work.
- Say each fact once. "A sealed rigid cylinder" already means fixed volume and fixed amount of gas.
- Do not put the deciding fact in the stem unless using it is the skill. Give n = 1.50 and ask for the refracted angle and the speed, instead of saying "glass has the higher index" and asking which way the ray bends.
- Never ask him to name a piece of the exam format: FRQ type names, rubric rows, task verbs. Test the skill itself.

## Structure

- A prompt that asks for two or more things uses parts (a), (b), (c), each with its own points, answer, and writing space. Never stack three questions on one block of lines.
- No numbered lists inside a prompt. The question numbers are 1, 2, 3, so "1." inside question 8 reads as question 1.
- A sketch or graph part gets `grid: true`. Written parts get lines. A grid never has to hold sentences.
- An item with parts carries no separate total. Its points are the sum of the parts, and only the parts show points.
- Points match the rubric line for line.

## Figures

- Every label sits next to the thing it names. An angle gets an arc between the two lines that form it, with the value inside the arc.
- Use the degree sign: 35°, not "35 degrees".
- Label only what the question refers to. Leave open room where he has to draw.

## Diagnostics

- One item per content unit, in CED unit order. `plan.json` lists the units and their topic keys.
- Skill units (FRQ types, Writing, Essays and MCQ pacing) are listed under `skills`. They never get their own item. Write one or two content items in that task's shape instead: an experimental design part, a thesis, an SAQ part.
- Test the core idea at AP level with a calculation or a reason, not a definition.
- End with one rating item: `type: "rating"`, empty prompt, `ratings` = every content unit in the plan with its id and name.
- About 25 minutes of questions, so the ratings fit in 30.

## Topic keys

Use the full key from `plan.json`, exam prefix included: `physics-2:13.3`, not `13.3`. A bare key never reaches the learner model, so the grade is lost.
