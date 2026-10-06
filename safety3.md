Write a single Python 3 script named mock_fr.py. Standard library only
(json, random, sys, urllib.request, datetime). No pip packages.
Output only the complete code, no explanation.

PURPOSE
Generate seeded mock "FieldRound" inspection data and POST it as JSON
to an n8n webhook, then print the JSON response.

CONSTANTS (top of file)
URL = "http://127.0.0.1:5678/webhook-test/fr-ingest"   # I will edit this
SEED = 42
PAST_ROUNDS = 6
ROUND_HOURS = 12

COMMAND-LINE FLAGS (check with "in sys.argv")
--stale : set generated_at to 30 hours before now
--clean : skip all planted problems below
--dry   : write mock_fr.json only, do not POST

TIME
now = current UTC time with minutes, seconds, microseconds set to 0.
All timestamps as strings in format "%Y-%m-%dT%H:%M:%SZ".

ASSETS (asset, checklist, area, criticality, responsible_role, items)
P-101, "Pump House A", "Area 1", "high", "supervisor",
  items: ("Bearing temp","C",20,75), ("Discharge pressure","bar",4.0,8.0)
P-102, "Pump House A", "Area 1", "medium", "supervisor",
  items: ("Bearing temp","C",20,75), ("Vibration","mm/s",0.0,7.1)
C-201, "Compressor Station B", "Area 2", "high", "supervisor",
  items: ("Oil level","%",40,90), ("Outlet temp","C",30,110)
T-301, "Tank Farm C", "Area 3", "low", "manager",
  items: ("Level","%",10,95)

ROUNDS
For each asset, create rounds for k = 6 down to 0 (oldest first).
k >= 1 : past round, due_at = now - 12*k hours, submitted.
k == 0 : upcoming round, due_at = now + 3 hours, not submitted.
Use random.Random(SEED) for all randomness.
Round IDs "R-001", "R-002", ... and reading IDs "rd-0001", "rd-0002", ...
in creation order.

Each round is a dict with EXACTLY these keys:
round_id, checklist, asset, area, criticality, responsible_role,
assigned_to, due_at, submitted_at, acknowledged, readings

- assigned_to: "tech-" + random int 10..99
- submitted_at: due_at + random 0..60 minutes if submitted, else None
- acknowledged: False
- readings: empty list if not submitted; otherwise one dict per item
  with EXACTLY these keys: reading_id, item, unit, value, low, high
- value: random uniform inside the middle 60% of [low, high]
  (low + 0.2*span to high - 0.2*span), rounded to 1 decimal

PLANTED PROBLEMS (apply after generating, unless --clean)
Here k=1 means the most recent past round, k=0 the upcoming one.
1. C-201 k=1: submitted_at = None, readings = []
2. P-102 k=1: "Vibration" value = None
3. T-301 k=1: "Level" value = 97.0
4. P-101 "Bearing temp": k=3 -> 79.0, k=2 -> 81.5, k=1 -> 84.0
5. P-102 k=2: "Vibration" value = 8.0 and acknowledged = True
6. C-201 k=0: assigned_to = None

PAYLOAD
{"generated_at": <now, or now-30h if --stale>, "rounds": [all rounds]}

OUTPUT
1. Write payload to mock_fr.json with indent=2. Print the round count.
2. Unless --dry: POST the payload as JSON (Content-Type: application/json)
   with urllib.request, timeout=120. Print the status code and the
   response parsed as JSON with indent=2.
3. Catch urllib.error.HTTPError: print the status code and the
   response body text.