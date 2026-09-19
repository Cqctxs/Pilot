# Pilot

> **A universal compatibility layer for software.**

### One-line pitch

> **Pilot gives every piece of software an API, whether its creator built one or not.**

### Bigger vision

Hardware became broadly programmable because developers stopped writing code for individual devices and started programming against common interfaces backed by device drivers.

Software never got the same abstraction.

Today, if a developer wants their product to work with UofT ACORN, Waterloo Quest, five airlines, three banks, or a company's internal ERP, they generally need to build and maintain a separate integration for every system. If that system has no API, developers are often stuck with brittle browser automation or no integration at all.

**Pilot creates the missing driver layer for software.**

Developers write against standardized capabilities such as:

```ts
interface StudentPortal {
  getCourses(term?: string): Promise<Course[]>;
  getSchedule(term?: string): Promise<Event[]>;
  getGrades(term?: string): Promise<Grade[]>;
  enroll(course: CourseID): Promise<Result>;
  drop(course: CourseID): Promise<Result>;
}
```

Individual **Pilots** implement that interface for specific pieces of software:

```text
education.student_portal@1

├── uoft/acorn
├── waterloo/quest
├── mit/websis
└── mcgill/minerva
```

A developer can then write:

```ts
const school = await pilot.connect(
  "education.student_portal"
);

const grades = await school.getGrades();
```

The exact university underneath no longer matters.

That's the core promise:

> **Write once. Run against any software.**

---

# The core idea

Pilot has three layers:

```text
                   APPLICATION
                       │
                       │
                Standard capability
                       │
                       ▼
              ┌─────────────────┐
              │  PILOT RUNTIME  │
              └────────┬────────┘
                       │
                  Pilot driver
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
         API         Browser        CLI
                                   / App
```

The application talks to a **capability**, not a website.

A Pilot translates that capability into whatever mechanism the underlying software requires.

That implementation could use a public API, reverse-engineered network endpoints, browser automation, a CLI, desktop interaction, or some combination of them.

The developer doesn't need to care.

---

# 1. Capability standards

A **capability standard** describes what a category of software can do.

For example:

```text
education.student_portal
travel.airline
commerce.storefront
commerce.subscription
finance.expense_system
developer.git_host
communication.messaging
```

Each standard defines a contract.

For an airline:

```ts
interface Airline {
  search(query: FlightQuery): Promise<Flight[]>;
  book(flight: Flight, passengers: Passenger[]): Promise<Booking>;
  getBooking(id: string): Promise<Booking>;
  change(id: string, flight: Flight): Promise<Result>;
  cancel(id: string): Promise<Result>;
  checkIn(id: string): Promise<BoardingPass>;
}
```

Then:

```text
travel.airline@1

├── aircanada
├── porter
├── delta
└── united
```

all expose the same programming model.

This is what makes Pilot more than a marketplace of automation scripts.

The important abstraction isn't:

> “Here is a script that clicks ACORN.”

It's:

> “ACORN is one implementation of a `StudentPortal`.”

---

# 2. Pilots

A **Pilot** is an implementation of one or more capability standards for a specific piece of software.

For example:

```text
uoft/acorn

implements:
  education.student_portal@1
  education.timetable@1
  education.tuition@1
```

A Pilot might expose:

```text
getCourses       ✓
getSchedule      ✓
getGrades        ✓
enroll           ✓
drop             ✓
transcript       ✗
```

Pilots should be reusable, versioned and testable.

Anyone can build one.

Anyone can publish one.

Anyone can use one.

So one person solving an integration problem can make that software accessible to the entire ecosystem.

---

# 3. The Pilot registry

Pilot should feel more like **npm for software capabilities** than an AI assistant.

A developer could run:

```bash
pilot search education.student_portal
```

and get:

```text
UofT ACORN
uoft/acorn

implements education.student_portal@1
✓ verified
18.4k executions
last tested 22m ago
```

Or:

```bash
pilot search uoft
```

and discover everything available for UofT:

```text
uoft/acorn
uoft/quercus
uoft/library
uoft/tcard
...
```

Then:

```bash
pilot add uoft/acorn
```

A developer shouldn't need to know anything about ACORN's implementation.

They only need to know:

```ts
await university.getGrades();
```

---

# 4. AI is the Pilot compiler

This is where the AI part becomes genuinely important.

AI should **not** reason through every action every time.

That would make Pilot another browser-use agent.

Instead, AI's role is to transform unfamiliar software into a reusable Pilot.

Imagine:

```bash
pilot create https://portal.example.edu
```

Pilot explores the site.

It discovers:

```text
Courses
Grades
Schedule
Registration
Transcript
```

It recognizes that this resembles:

```text
education.student_portal@1
```

Then maps the website onto the standard:

```text
getCourses      ✓
getSchedule     ✓
getGrades       ✓
enroll          ✓
drop            ✓
transcript      ✓
```

It generates an implementation, runs tests, fixes failures, and produces:

```text
example/student-portal v1.0.0
```

Now everyone can use it without repeating the AI reasoning.

The architecture becomes:

```text
Unknown software
      ↓
AI understands functionality
      ↓
Capability standard selected
      ↓
Pilot generated
      ↓
Contract tests generated/run
      ↓
Reusable deterministic driver
      ↓
Registry
```

This is one of Pilot's most important ideas:

> **Use AI to compile understanding into reusable software.**

Not:

> use AI forever to click buttons.

---

# 5. Self-healing Pilots

Browser integrations have historically been brittle.

Pilot attacks that problem directly.

Every Pilot has semantic contract tests:

```text
uoft/acorn

✓ authentication
✓ getCourses
✓ getSchedule
✓ getGrades
✓ enroll
```

Suppose the underlying site changes:

```text
"Academic History"

becomes

"Grades & Records"
```

The Pilot fails a contract test.

Then the AI maintainer can:

```text
Detect failure
     ↓
Inspect new interface
     ↓
Understand intended outcome
     ↓
Find equivalent interaction
     ↓
Patch Pilot
     ↓
Run contract tests
     ↓
Publish repaired version
```

So the AI isn't merely generating integrations.

It helps **maintain an enormous integration ecosystem**.

That is what could make Pilot scale.

---

# 6. Authentication and permissions

Pilot should not expose user passwords directly to applications.

Instead:

```ts
const acorn = await pilot.connect("uoft/acorn");
```

If authentication is required:

```text
Application
     ↓
requests capability
     ↓
Pilot
     ↓
trusted auth flow
     ↓
UofT login / Duo / passkey
     ↓
authorized session
```

The application gets permission to perform certain operations, rather than getting raw credentials.

You could even make capability permissions explicit:

```text
Schedule Planner wants permission to:

✓ Read courses
✓ Read schedule
✗ Read grades
✗ Enroll in courses
✗ Drop courses
```

That becomes an important long-term security property:

> **Applications receive capabilities, not credentials.**

---

# The first HackMIT demo

I still think universities are the ideal proof-of-concept.

You build one tiny application:

```text
┌───────────────────────────────────────┐
│            UNIVERSAL CAMPUS           │
│                                       │
│ ECE241                   A-           │
│ ECE243                   B+           │
│ MAT290                   A            │
│                                       │
│ Next class                            │
│ ECE241 · 3:00 PM · SF1105             │
└───────────────────────────────────────┘
```

Its backend contains something like:

```ts
const university =
  await pilot.connect("education.student_portal");

const grades =
  await university.getGrades();

const schedule =
  await university.getSchedule();
```

Now do the demo in three stages.

### Stage 1 — Same code, different software

Choose:

```text
University of Toronto
```

It works through the UofT Pilot.

Then switch to:

```text
Waterloo
```

The application code doesn't change.

Different portal. Same capability.

That proves the abstraction.

### Stage 2 — Software with no Pilot

Select:

```text
HackMIT University
```

No Pilot exists.

Pilot says:

```text
No compatible Pilot found.

[Create Pilot]
```

The AI explores the portal.

```text
Detected:
✓ courses
✓ grades
✓ schedule
✓ enrollment

Mapping:
education.student_portal@1
```

It creates and tests the new Pilot.

Now rerun the exact same application.

It works.

That proves **AI compilation**.

### Stage 3 — Break the portal

During the demo, deliberately modify HackMIT University's website.

Change navigation, labels, or DOM structure.

The integration breaks.

Pilot detects:

```text
Contract failure:
getGrades()
```

Then:

```text
Repairing...

Observed:
"Academic Records"
→
"Grades & Transcript"

Patch generated.

Running tests...

✓ getCourses
✓ getSchedule
✓ getGrades
✓ enroll

Pilot updated to v1.0.1
```

Run the original app again.

It works.

That proves **self-healing compatibility**.

Those three moments explain essentially the whole project.

---

# What makes Pilot different from browser agents

This will probably be the first technical question judges ask.

A browser agent does:

```text
User asks for action
      ↓
LLM reasons
      ↓
interacts with UI
      ↓
action complete
```

Every new task involves more reasoning.

Pilot does:

```text
AI understands software once
      ↓
compiles that understanding
      ↓
Pilot
      ↓
standardized deterministic interface
      ↓
used repeatedly by arbitrary applications
```

So:

> **Agents execute tasks. Pilot creates interfaces.**

Or even more simply:

> **A browser agent figures out how to use software. Pilot turns that knowledge into infrastructure everyone else can reuse.**

That's probably the cleanest distinction.

---

# Why this could matter

The internet contains an enormous amount of functionality that developers simply cannot access.

Some software has excellent APIs.

Some has incomplete APIs.

Some has private APIs.

Some has ancient APIs.

Some has none.

And enterprise environments are even worse.

That creates a massive integration tax.

Every developer repeatedly writes:

```text
Our Salesforce integration
Our Workday integration
Our university integration
Our airline integration
Our vendor integration
...
```

Pilot attempts to decouple:

> **what software can do**

from:

> **how one particular vendor happened to implement it.**

Over time, the ecosystem could grow into:

```text
                           PILOT
                             │
         ┌───────────────────┼───────────────────┐
         │                   │                   │
     Education             Travel            Commerce
         │                   │                   │
 universities            airlines             stores
 LMS systems              hotels          subscriptions

         │                   │                   │
     Developer            Finance          Enterprise
         │                   │                   │
       Git                 banks               HR
      CI/CD              accounting            ERP
      cloud                expenses         legacy apps
```

Eventually, applications start targeting **capabilities instead of vendors**.

That is the long-term vision.

---

# HackMIT track strategy

The project should fundamentally be built for **Warp + OpenAI + Cognition**. The others should fall out naturally rather than feeling bolted on.

| Track                             | Pilot angle                                                                                                                                                                                                                                                                       |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Warp — Best Developer Tool**    | This is Pilot's strongest direct fit. Pilot changes how developers integrate software by letting them target standardized capabilities rather than specific vendors. Warp explicitly wants projects that improve the developer experience.                                        |
| **OpenAI Challenge**              | OpenAI powers software understanding, capability matching, Pilot generation, testing and automatic repair. Their challenge specifically evaluates both creative OpenAI API usage and meaningful Codex involvement during development.                                             |
| **Cognition — Best Use of Devin** | Devin can act as an autonomous Pilot engineer: inspect an unfamiliar application, implement a standard, run contract tests, debug it and iterate until it passes. Cognition says ambitious projects are welcome and judges creativity, novelty and polish.                        |
| **Token Company**                 | Traditional computer-use agents repeatedly spend tokens reasoning through the same workflows. Pilot spends intelligence up front, then executes the compiled result cheaply thousands of times. Their challenge explicitly rewards creative reductions in LLM cost.               |
| **Ramp**                          | Pilot saves developers and companies the cost of repeatedly building and maintaining integrations. Ramp's challenge is simply to build something that saves people time and money.                                                                                                |
| **Long Lake**                     | “Give Pilot a website with no API; shortly afterward we're calling it from code” is a very tangible demonstration of AI doing something beyond chat or search. That's closely aligned with Long Lake's goal of creating an AI experience compelling enough to win over skeptics.  |
| **Maximor**                       | A finance Pilot demo could connect incompatible banking/accounting/vendor systems through shared interfaces. Maximor specifically wants multi-step financial agents that handle exceptions and improve through repeated runs.                                                     |
| **Visa**                          | A `commerce.storefront` standard could let a developer build one shopping experience across many otherwise incompatible merchants. Visa's challenge spans discovery, comparison, checkout and payments.                                                                           |

For the hackathon itself, I would **not** spend time specifically building Maximor or Visa features unless the main project is finished.

The first four are enough to give us a strong submission strategy.

---

# The Token Company angle is particularly clever

Pilot introduces what you could call **inference compilation**.

Compare:

```text
Browser agent

Action 1 → LLM
Action 2 → LLM
Action 3 → LLM
Action 4 → LLM
...
Action 10,000 → LLM
```

with:

```text
Pilot

LLM
 ↓
compile Pilot
 ↓
deterministic execution
 ↓
deterministic execution
 ↓
deterministic execution
 ↓
...
```

The AI discovers the procedure once.

Then everyone reuses the result.

If we instrument the demo and show actual token usage and cost, we could make a very compelling submission to a challenge specifically about creative LLM cost reduction. 

---

# MVP scope

The biggest risk is trying to build “the API for the entire internet” in one weekend.

Don't.

The MVP only needs to prove the abstraction.

I would build exactly:

1. `education.student_portal@1`, with perhaps four methods: `getCourses`, `getSchedule`, `getGrades`, `enroll`.
2. Two existing Pilots that implement it.
3. A tiny TypeScript SDK exposing `pilot.connect()`.
4. A minimal searchable registry.
5. An AI system capable of generating a Pilot for one previously unseen mock website.
6. Contract tests for the capability.
7. Automatic repair after intentionally changing that website.

Everything else is presentation of the vision.

If those seven things genuinely work, the project already demonstrates something extremely ambitious.

---

# Possible terminology

The naming actually works nicely throughout the product.

Instead of:

```text
driver
driver registry
driver compiler
driver runtime
driver standard
```

you can say:

```text
Pilot                 individual adapter
Pilot Registry        marketplace/discovery
Pilot Runtime         executes Pilots
Pilot Compiler        AI generation system
Capability Standard  shared interface contract
Pilot SDK             developer library
Pilot Cloud           hosted registry/testing/repair
```

I particularly like:

> **Build a Pilot**

for creating an integration.

And:

> **This software already has a Pilot.**

It gives the ecosystem its own vocabulary.

---

# Branding / tagline

I'd keep the primary tagline highly concrete:

> **Pilot — Give any software an API.**

Then beneath it:

> **Build against capabilities, not vendors.**

And the larger philosophical statement:

> **If a human can use it, a developer should be able to program it.**

For a demo slide:

> **APIs require permission from the software creator. Pilots don't.**

That line captures why this isn't just another API aggregation service.

---

# 30-second pitch

> **Every piece of hardware has a driver, but software doesn't. Developers still rebuild integrations for every website, enterprise tool, university portal, and service they want to support — assuming those systems even expose an API. Pilot is a universal driver layer for software. Developers program against standardized capabilities like `StudentPortal` or `Airline`, while Pilots translate those capabilities into whatever each underlying system requires. AI can automatically build, test and repair those Pilots. So instead of every developer integrating every service independently, one person can make a piece of software programmable for everyone.**

And then I'd end with:

> **Pilot's goal is simple: give every piece of software in the world an API.**

That feels like the version worth building.
