AI Handoff Essentials

Included for run + deep architecture study:
- server.js, index.html
- package.json, package-lock.json
- .env.example (template only)
- css/, js/, src/
- data/ (skill bank + vector store + style profile)
- docs/ (project and technical deep dive)
- scripts/ (import and utility scripts)

Excluded to keep package lean:
- node_modules/ (reinstall with npm install)
- .env (contains secrets)
- library/ (large source PDFs/assets, optional)
- eng.traineddata (OCR optional)
- generated/ (outputs)

Run steps on target machine:
1) npm install
2) copy .env.example to .env and fill keys
3) node server.js
