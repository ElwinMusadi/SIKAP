const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, '../src/frontend');
const distDir = path.join(__dirname, '../dist');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function resolveIncludes(content) {
  // Regex matches <?!= include('Filename'); ?> or <?!= include("Filename") ?>
  const regex = /<\?!=\s*include\(['"]([^'"]+)['"]\);?\s*\?>/g;
  
  return content.replace(regex, (match, filename) => {
    // If the filename starts with 'frontend/', strip it since we are already looking in src/frontend
    const cleanFilename = filename.replace(/^frontend\//, '');
    const filePath = path.join(srcDir, `${cleanFilename}.html`);
    
    if (fs.existsSync(filePath)) {
      console.log(`Resolving include: ${filename}`);
      let fileContent = fs.readFileSync(filePath, 'utf-8');
      // Recursively resolve includes inside the included file
      return resolveIncludes(fileContent);
    } else {
      console.warn(`Warning: Could not find include file: ${filePath}`);
      return match;
    }
  });
}

function build() {
  ensureDir(distDir);
  const indexPath = path.join(srcDir, 'Index.html');
  
  if (fs.existsSync(indexPath)) {
    console.log('Starting Cloudflare build...');
    let content = fs.readFileSync(indexPath, 'utf-8');
    
    // Resolve all includes
    const resolvedContent = resolveIncludes(content);
    
    // Write final output to dist/index.html
    const outPath = path.join(distDir, 'index.html');
    fs.writeFileSync(outPath, resolvedContent);
    
    console.log(`Build successful: dist/index.html generated.`);
  } else {
    console.error(`Error: Index.html not found in ${srcDir}.`);
    process.exit(1);
  }
}

build();
