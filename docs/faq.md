# FAQ

**Does closing my browser cancel a task?** No, independent background task units continue. Interactive chat modes have separate service lifecycles.

**Can it automatically break down any project and merge the result?** Auto Mode can plan, route and integrate tested steps into its own branch. It never changes the project branch without an explicit operator merge. Manual tasks remain supported.

**Are subscriptions interchangeable with API keys?** No. Each provider uses its supported authentication and separate usage/billing. No unlimited API access is promised.

**Is it safe for anonymous users or untrusted tenants?** No. It is an authenticated single-operator command-execution tool. Use stronger OS isolation before untrusted workloads.

**Can I use another OS?** Not as a verified installation target. Ubuntu 24.04 x86_64 is the current beta target.

**Will an agent resume exactly where it was after a reboot?** Not guaranteed. Process memory is lost; explicit bounded checkpoint/native-session continuation exists but host reboot acceptance is unverified.

**Are CI agents real Claude/Codex accounts?** No. CI exercises actual services, queues and controlled infrastructure fixtures without provider credentials. Historical private deployment live-provider results are documented separately and do not certify this portable release on every server.

**Is HTTPS mandatory?** Public access requires trusted HTTPS and both authentication layers. Private HTTP is supported only through an encrypted SSH tunnel.
