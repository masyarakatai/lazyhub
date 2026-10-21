import { describe, it, expect } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { readFileSync } from 'fs'
import { getMarkdownRows, TextInput, decodeHtmlEntities, sanitize, displayWidth, truncateToWidth, truncateEllipsis, formatLogin, padEndWidth, padStartWidth } from './utils.js'
import { ThemeProvider } from './theme.js'

const mockTheme = {
  ui: { selected: 'cyan', muted: 'grey', dim: 'grey', headerBg: 'blue' },
  pr: { draft: 'grey' },
  ci: { pending: 'yellow', pass: 'green' },
}

const stringWidthPkg = JSON.parse(
  readFileSync(new URL('../node_modules/string-width/package.json', import.meta.url), 'utf8')
)

function expectAllowedDisplayWidths(input, allowedWidths, label) {
  const actualWidth = displayWidth(input)
  const allowed = new Set(allowedWidths)
  const context = [
    `label=${label}`,
    `input=${JSON.stringify(input)}`,
    `actual=${actualWidth}`,
    `allowed=${[...allowed].join(',')}`,
    `string-width=${stringWidthPkg.version}`,
    `platform=${process.platform}`,
    `node=${process.version}`,
  ].join(' ')

  if (!allowed.has(actualWidth)) {
    throw new Error(`Unexpected display width: ${context}`)
  }
}

describe('getMarkdownRows', () => {
  it('should render headers correctly', () => {
    const rows = getMarkdownRows('# Header 1\n## Header 2', 80, mockTheme)
    expect(rows).toHaveLength(2)
    // Header 1 is uppercase
    expect(rows[0].props.children.props.children).toBe('HEADER 1')
    expect(rows[1].props.children.props.children).toBe('Header 2')
  })

  it('should render list items', () => {
    const rows = getMarkdownRows('* item 1\n- item 2', 80, mockTheme)
    expect(rows).toHaveLength(2)
    expect(rows[0].props.children[0].props.children).toBe('• ')
  })
})

describe('TextInput', () => {
  it('should render value', () => {
    const { lastFrame } = render(
      React.createElement(ThemeProvider, { initialTheme: 'ansi-16' },
        React.createElement(TextInput, { value: 'hello', focus: true })
      )
    )
    expect(lastFrame()).toContain('hello')
  })
})

// ── Bug 1 regression: HTML entity decoding ────────────────────────────────────

describe('decodeHtmlEntities', () => {
  it('decodes the 5 standard XML entities', () => {
    expect(decodeHtmlEntities('&amp;&lt;&gt;&quot;&#39;')).toBe('&<>"\'')
  })

  it('decodes mixed fixture: &#39;test&amp;&lt;', () => {
    expect(decodeHtmlEntities("&#39;test&amp;&lt;")).toBe("'test&<")
  })

  it('does not double-decode', () => {
    // If input is already decoded, running again should be idempotent
    const decoded = decodeHtmlEntities("it's <fine> & \"ok\"")
    expect(decoded).toBe("it's <fine> & \"ok\"")
    expect(decodeHtmlEntities(decoded)).toBe(decoded)
  })

  it('decodes numeric decimal entities', () => {
    expect(decodeHtmlEntities('&#65;&#66;&#67;')).toBe('ABC')
  })

  it('handles non-string input gracefully', () => {
    expect(decodeHtmlEntities(null)).toBe('')
    expect(decodeHtmlEntities(undefined)).toBe('')
    expect(decodeHtmlEntities(42)).toBe('42')
  })
})

describe('sanitize (includes entity decoding)', () => {
  it('strips ANSI and decodes HTML entities', () => {
    const input = '\x1b[31m&lt;b&gt;hello&amp;world&lt;/b&gt;\x1b[0m'
    expect(sanitize(input)).toBe('<b>hello&world</b>')
  })

  it('collapses whitespace control chars', () => {
    expect(sanitize('foo\tbar\nbaz')).toBe('foo bar baz')
  })
})

// ── Bug 6 regression: wide-character display width ────────────────────────────

describe('displayWidth', () => {
  it('returns correct width for ASCII', () => {
    expect(displayWidth('hello')).toBe(5)
    expect(displayWidth('')).toBe(0)
  })

  it('counts CJK characters as 2 columns each', () => {
    expect(displayWidth('修复')).toBe(4)   // 2 CJK chars × 2 = 4
    expect(displayWidth('修复 PR')).toBe(7) // 4 + 1 space + 2 ASCII
  })

  it('counts emoji as 2 columns each', () => {
    expect(displayWidth('🚀')).toBe(2)
    expect(displayWidth('🚀 fix')).toBe(6) // 2 + 1 + 3
  })

  it('treats zero-width joiners and variation selectors as 0 width', () => {
    // ZWJ sequence: man+ZWJ+laptop = 1 visible glyph but 3+ code points
    expect(displayWidth('‍')).toBe(0)
    expect(displayWidth('️')).toBe(0)
  })

  it('handles combining marks (0 width)', () => {
    // e + combining acute = 1 visible char
    expect(displayWidth('é')).toBe(1)
  })

  it('handles ZWJ family emoji with platform-tolerant diagnostics', () => {
    // 👨‍👩‍👧‍👦 is a multi-code-point ZWJ sequence. Depending on the Unicode
    // tables behind string-width / terminal interpretation, it may report as:
    // - 2 columns (single wide emoji cluster)
    // - 8 columns (4 constituent emoji, each wide)
    // We keep the assertion informative and stable across environments.
    expectAllowedDisplayWidths('👨‍👩‍👧‍👦', [2, 8], 'ZWJ family emoji')
  })

  it('handles regional indicator flag emoji (2 columns)', () => {
    // 🇺🇸 is two regional indicator code points but renders as one flag
    // string-width treats it as width 2
    expect(displayWidth('🇺🇸')).toBe(2)
  })
})

describe('truncateToWidth', () => {
  it('does not truncate strings within budget', () => {
    expect(truncateToWidth('hello', 10)).toBe('hello')
  })

  it('truncates ASCII correctly', () => {
    expect(truncateToWidth('hello world', 5)).toBe('hello')
  })

  it('truncates CJK strings respecting 2-col width', () => {
    // '修复 PR' has display width 7; truncate to 4 → '修复'
    expect(truncateToWidth('修复 PR', 4)).toBe('修复')
  })

  it('truncates emoji strings respecting 2-col width', () => {
    expect(truncateToWidth('🚀 fix', 4)).toBe('🚀 f')
  })
})

describe('padEndWidth / padStartWidth', () => {
  it('padEndWidth pads ASCII to correct width', () => {
    const padded = padEndWidth('hi', 6)
    expect(padded).toBe('hi    ')
    expect(displayWidth(padded)).toBe(6)
  })

  it('padEndWidth does not over-pad CJK (already at or over budget)', () => {
    const s = '修复'  // display width 4
    expect(padEndWidth(s, 4)).toBe(s)
    expect(padEndWidth(s, 3)).toBe(s) // already wider than budget — return as-is
  })

  it('padEndWidth pads short CJK to correct width', () => {
    const padded = padEndWidth('修', 4)  // '修' is width 2, pad to 4
    expect(padded).toBe('修  ')
    expect(displayWidth(padded)).toBe(4)
  })

  it('padStartWidth pads on the left', () => {
    expect(padStartWidth('5m', 4)).toBe('  5m')
  })
})

describe('truncateEllipsis / formatLogin', () => {
  it('returns fitting strings unchanged and cuts others with an ellipsis within width', () => {
    expect(truncateEllipsis('Issues', 8)).toBe('Issues')
    const out = truncateEllipsis('Notifications', 8)
    expect(out).toBe('Notific…')
    expect(displayWidth(out)).toBe(8)
  })

  it('drops the [bot] suffix and ellipsizes only when still too long', () => {
    expect(formatLogin('dev-agent[bot]', 11)).toBe('dev-agent')
    expect(formatLogin('dependabot[bot]', 11)).toBe('dependabot')
    expect(formatLogin('a-very-long-login-name', 11)).toBe('a-very-lon…')
  })
})
