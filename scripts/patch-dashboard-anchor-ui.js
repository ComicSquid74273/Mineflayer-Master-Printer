const fs = require('fs');

// 1. Update index.html
let html = fs.readFileSync('dashboard-service/public/index.html', 'utf8');
const anchorFieldset = `
          <fieldset class="upload-anchor-fieldset">
            <legend>Starting Point / Anchor Tag (North-West Bottom)</legend>
            <p class="hint">Starting world coordinates for the bottom-most, north-most, west-most block of this structure.</p>
            <div class="upload-anchor-inputs">
              <label>
                <span>Anchor X (West)</span>
                <input id="structureAnchorX" type="number" value="-355" placeholder="-355" required aria-label="Structure Anchor X" data-permission-needed="canOperate">
              </label>
              <label>
                <span>Anchor Y (Bottom)</span>
                <input id="structureAnchorY" type="number" value="66" placeholder="66" required aria-label="Structure Anchor Y" data-permission-needed="canOperate">
              </label>
              <label>
                <span>Anchor Z (North)</span>
                <input id="structureAnchorZ" type="number" value="-88" placeholder="-88" required aria-label="Structure Anchor Z" data-permission-needed="canOperate">
              </label>
            </div>
          </fieldset>`;

if (!html.includes('upload-anchor-fieldset')) {
  const idx = html.indexOf('id="fileInput"');
  const labelEnd = html.indexOf('</label>', idx) + 8;
  html = html.slice(0, labelEnd) + anchorFieldset + html.slice(labelEnd);
  fs.writeFileSync('dashboard-service/public/index.html', html, 'utf8');
  console.log('Updated index.html with anchor fieldset');
} else {
  console.log('index.html already has upload-anchor-fieldset');
}

// 2. Update styles.css
let css = fs.readFileSync('dashboard-service/public/assets/styles.css', 'utf8');
const cssRules = `
.upload-anchor-fieldset {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
  border: 2px solid var(--accent, #4f8df7);
  border-radius: 10px;
  background: rgba(79, 141, 247, 0.08);
}
.upload-anchor-fieldset legend {
  font-weight: 700;
  font-size: 0.95rem;
  color: var(--accent, #4f8df7);
  padding: 0 8px;
}
.upload-anchor-inputs {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
}
.upload-anchor-inputs label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  min-width: 90px;
}
.upload-anchor-inputs input {
  padding: 8px 10px;
  border: 1px solid var(--line, #333);
  border-radius: 6px;
  background: var(--surface, #1e222b);
  color: inherit;
  font-size: 0.95rem;
  font-weight: 600;
}
`;
if (!css.includes('.upload-anchor-fieldset')) {
  css += cssRules;
  fs.writeFileSync('dashboard-service/public/assets/styles.css', css, 'utf8');
  console.log('Updated styles.css with anchor fieldset styles');
} else {
  console.log('styles.css already has upload-anchor-fieldset');
}

// 3. Update app.js
let app = fs.readFileSync('dashboard-service/public/assets/app.js', 'utf8');

// Add element references if missing
if (!app.includes('structureAnchorX:')) {
  app = app.replace("fileInput: document.getElementById('fileInput'),", `fileInput: document.getElementById('fileInput'),
  structureAnchorX: document.getElementById('structureAnchorX'),
  structureAnchorY: document.getElementById('structureAnchorY'),
  structureAnchorZ: document.getElementById('structureAnchorZ'),`);
  console.log('Added element references in app.js');
}

// Update onUpload to actively prompt user
if (!app.includes("window.prompt(`Enter starting Anchor Tag")) {
  const onUploadMarker = 'async function onUpload(event) {';
  const onUploadIdx = app.indexOf(onUploadMarker);
  const filesLine = 'const files = Array.from(elements.fileInput.files || [])';
  const filesIdx = app.indexOf(filesLine, onUploadIdx);
  const ifNotFiles = 'if (!files.length) return';
  const returnIdx = app.indexOf(ifNotFiles, filesIdx) + ifNotFiles.length;

  const askBlock = `

  const currentAnchorStr = [
    elements.structureAnchorX?.value?.trim() || '-355',
    elements.structureAnchorY?.value?.trim() || '66',
    elements.structureAnchorZ?.value?.trim() || '-88'
  ].join(',')

  const fileName = files[0]?.name || 'structure'
  const promptInput = window.prompt(
    \`Enter starting Anchor Tag (North-West Bottom: X, Y, Z coordinates) for \${fileName}:\`,
    currentAnchorStr
  )

  if (promptInput === null) {
    pushEvent('warn', 'Upload cancelled: Anchor Tag (North-West Bottom starting point) is required.')
    elements.uploadStatus.textContent = 'Upload cancelled: Anchor Tag was not provided.'
    return
  }

  const parts = String(promptInput).split(',').map((p) => Number(p.trim()))
  if (parts.length !== 3 || !parts.every(Number.isFinite)) {
    window.alert('Invalid anchor coordinates! Please enter 3 numbers separated by commas: X, Y, Z (e.g. -355, 66, -88)')
    pushEvent('error', 'Invalid anchor tag entered. Upload cancelled.')
    elements.uploadStatus.textContent = 'Upload cancelled: Invalid anchor coordinates.'
    return
  }

  const [anchorX, anchorY, anchorZ] = parts
  if (elements.structureAnchorX) elements.structureAnchorX.value = anchorX
  if (elements.structureAnchorY) elements.structureAnchorY.value = anchorY
  if (elements.structureAnchorZ) elements.structureAnchorZ.value = anchorZ`;

  app = app.slice(0, returnIdx) + askBlock + app.slice(returnIdx);

  // Replace form.append('maxAttempts', '3') to add anchor
  const appendMarker = "form.append('maxAttempts', '3')";
  const appendWithAnchor = `form.append('maxAttempts', '3')
    form.append('anchorX', String(anchorX))
    form.append('anchorY', String(anchorY))
    form.append('anchorZ', String(anchorZ))`;
  app = app.replace(appendMarker, appendWithAnchor);

  fs.writeFileSync('dashboard-service/public/assets/app.js', app, 'utf8');
  console.log('Added explicit anchor prompt logic to onUpload in app.js');
}

// Add change listener to fileInput
if (!app.includes("fileInput.addEventListener('change'")) {
  const listener = `
if (elements.fileInput) {
  elements.fileInput.addEventListener('change', () => {
    const file = elements.fileInput.files?.[0]
    if (!file) return
    const currentAnchor = \`\${elements.structureAnchorX?.value || '-355'},\${elements.structureAnchorY?.value || '66'},\${elements.structureAnchorZ?.value || '-88'}\`
    const entered = window.prompt(\`Selected \${file.name}. Please enter or confirm starting Anchor Tag (North-West Bottom: X, Y, Z coordinates):\`, currentAnchor)
    if (entered) {
      const parts = entered.split(',').map((p) => Number(p.trim()))
      if (parts.length === 3 && parts.every(Number.isFinite)) {
        if (elements.structureAnchorX) elements.structureAnchorX.value = parts[0]
        if (elements.structureAnchorY) elements.structureAnchorY.value = parts[1]
        if (elements.structureAnchorZ) elements.structureAnchorZ.value = parts[2]
        pushEvent('info', \`Set starting anchor for \${file.name}: \${parts[0]}, \${parts[1]}, \${parts[2]}\`)
      }
    }
  })
}
`;
  app += listener;
  fs.writeFileSync('dashboard-service/public/assets/app.js', app, 'utf8');
  console.log('Added fileInput change prompt listener to app.js');
}
