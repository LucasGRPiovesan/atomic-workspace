import type { SourceSection } from '../types.js';

/**
 * Split markdown content into sections by headings (# .. ###).
 * Strips YAML front-matter but uses its `description`/`name` for the title.
 * Keeps start/end lines (1-based), merges consecutive tiny sections (< 200 chars) into the previous one,
 * drops empty sections.
 */
export function splitMarkdownSections(content: string): SourceSection[] {
  const lines = content.split('\n');
  const sections: SourceSection[] = [];
  let frontMatterEnd = -1;
  let frontMatterTitle = '';
  let frontMatterDescription = '';
  
  // Check for YAML front matter
  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') {
        frontMatterEnd = i;
        break;
      }
      const line = lines[i];
      if (line.startsWith('title:')) {
        frontMatterTitle = line.slice(6).trim().replace(/^["']|["']$/g, '');
      } else if (line.startsWith('description:')) {
        frontMatterDescription = line.slice(12).trim().replace(/^["']|["']$/g, '');
      } else if (line.startsWith('name:')) {
        frontMatterTitle = line.slice(5).trim().replace(/^["']|["']$/g, '');
      }
    }
  }
  
  const hasFrontMatter = frontMatterEnd >= 0;
  let currentHeading = hasFrontMatter ? (frontMatterTitle || frontMatterDescription || 'Introduction') : 'Introduction';
  let currentText = '';
  let currentStart = hasFrontMatter ? frontMatterEnd + 2 : 1; // 1-based line where content starts
  let hasContent = false;
  let firstHeadingProcessed = false;
  let lastContentLine = currentStart - 1; // Track last line with actual content
  
  for (let i = hasFrontMatter ? frontMatterEnd + 1 : 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    
    if (headingMatch) {
      if (!firstHeadingProcessed && hasFrontMatter) {
        // With front matter: first heading goes into content, doesn't create new section
        currentText += line + '\n';
        hasContent = true;
        lastContentLine = i + 1; // 1-based
        firstHeadingProcessed = true;
        continue;
      }
      
      // Save previous section if it has content
      if (hasContent) {
        sections.push({
          heading: currentHeading,
          text: currentText.trim(),
          startLine: currentStart,
          endLine: lastContentLine
        });
      } else if (!firstHeadingProcessed && !hasFrontMatter) {
        // First heading without front matter: use it as the first section heading
        currentHeading = headingMatch[2].trim();
        currentStart = i + 1; // heading line (1-based)
        firstHeadingProcessed = true;
        continue;
      }
      
      // Start new section at this heading line (1-based = i + 1)
      currentHeading = headingMatch[2].trim();
      currentText = '';
      currentStart = i + 1;
      hasContent = false;
      lastContentLine = i; // heading line itself
      firstHeadingProcessed = true;
    } else {
      if (line.trim().length > 0) {
        hasContent = true;
        lastContentLine = i + 1; // 1-based
      }
      currentText += line + '\n';
    }
  }
  
  // Add final section
  if (hasContent || currentStart <= lines.length) {
    sections.push({
      heading: currentHeading,
      text: currentText.trim(),
      startLine: currentStart,
      endLine: lastContentLine > 0 ? lastContentLine : currentStart
    });
  }
  
  return mergeTinySections(sections);
}

/**
 * Split non-markdown content (like .cursorrules, .windsurfrules) into sections
 * by blank-line-separated block groups, max ~1500 chars each.
 * Does NOT merge consecutive blocks - only splits blocks that exceed 1500 chars.
 */
export function splitNonMarkdownSections(content: string): SourceSection[] {
  const lines = content.split('\n');
  const sections: SourceSection[] = [];
  let currentBlock = '';
  let blockStartLine = 1;
  let inBlock = false;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isBlank = line.trim().length === 0;
    
    if (isBlank) {
      if (inBlock && currentBlock.trim().length > 0) {
        // End of block - split if too large
        const blockText = currentBlock.trim();
        if (blockText.length <= 1500) {
          sections.push({
            heading: 'Content',
            text: blockText,
            startLine: blockStartLine,
            endLine: i // 1-based, current line is blank so block ends at previous line
          });
        } else {
          // Split large block into ~1500 char chunks
          const chunks = splitLargeText(blockText, 1500);
          let chunkStartLine = blockStartLine;
          for (const chunk of chunks) {
            const chunkLines = chunk.split('\n').length;
            sections.push({
              heading: 'Content',
              text: chunk,
              startLine: chunkStartLine,
              endLine: chunkStartLine + chunkLines - 1
            });
            chunkStartLine += chunkLines;
          }
        }
        currentBlock = '';
        inBlock = false;
      }
    } else {
      if (!inBlock) {
        blockStartLine = i + 1;
        inBlock = true;
      }
      currentBlock += line + '\n';
    }
  }
  
  // Add final block
  if (inBlock && currentBlock.trim().length > 0) {
    const blockText = currentBlock.trim();
    if (blockText.length <= 1500) {
      sections.push({
        heading: 'Content',
        text: blockText,
        startLine: blockStartLine,
        endLine: lines.length
      });
    } else {
      const chunks = splitLargeText(blockText, 1500);
      let chunkStartLine = blockStartLine;
      for (const chunk of chunks) {
        const chunkLines = chunk.split('\n').length;
        sections.push({
          heading: 'Content',
          text: chunk,
          startLine: chunkStartLine,
          endLine: chunkStartLine + chunkLines - 1
        });
        chunkStartLine += chunkLines;
      }
    }
  }
  
  // Drop empty sections
  return sections.filter(s => s.text.trim().length > 0);
}

function splitLargeText(text: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  
  while (remaining.length > maxChars) {
    // Find a good split point near maxChars (prefer line breaks)
    let splitIndex = maxChars;
    const newlineIndex = remaining.lastIndexOf('\n', maxChars);
    if (newlineIndex > maxChars * 0.5) {
      splitIndex = newlineIndex + 1;
    }
    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex);
  }
  if (remaining.length > 0) {
    chunks.push(remaining);
  }
  return chunks;
}

/**
 * Merge consecutive tiny sections (< maxChars) into the previous one.
 * Drop empty sections.
 */
export function mergeTinySections(sections: SourceSection[], maxChars = 200): SourceSection[] {
  if (sections.length <= 1) return sections;
  
  const merged: SourceSection[] = [];
  let current = sections[0];
  
  for (let i = 1; i < sections.length; i++) {
    const next = sections[i];
    if (current.text.length < maxChars && next.text.length < maxChars) {
      // Merge into current
      current = {
        heading: current.heading,
        text: current.text + '\n\n' + next.text,
        startLine: current.startLine,
        endLine: next.endLine
      };
    } else {
      merged.push(current);
      current = next;
    }
  }
  merged.push(current);
  
  // Drop empty sections
  return merged.filter(s => s.text.trim().length > 0);
}