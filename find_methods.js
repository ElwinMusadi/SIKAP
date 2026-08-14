const fs = require('fs');
const path = require('path');

const jsDir = path.join(__dirname, 'frontend', 'js');
const files = fs.readdirSync(jsDir).filter(f => f.endsWith('.js') && f !== 'JS_Api.js');

const methods = new Set();

for (const file of files) {
  const filePath = path.join(jsDir, file);
  const content = fs.readFileSync(filePath, 'utf8');

  // Match: .methodName(
  // But we want to only catch the last call in the chain.
  // The chain looks like google.script.run ... .methodName(args);
  const regex = /google\.script\.run[\s\S]*?\.withFailureHandler[\s\S]*?\.([a-zA-Z0-9_]+)\(|google\.script\.run\s*\.([a-zA-Z0-9_]+)\(/g;
  
  let match;
  while ((match = regex.exec(content)) !== null) {
    if (match[1]) methods.add(match[1]);
    if (match[2] && match[2] !== 'withSuccessHandler' && match[2] !== 'withFailureHandler') methods.add(match[2]);
  }
}

console.log("METHODS USED:");
console.log(Array.from(methods).join('\n'));
