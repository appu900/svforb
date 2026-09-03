"""Renders docs/openapi.json into a Markdown reference and a browsable HTML page."""
import json, html, re, os, collections

SPEC = json.load(open('docs/openapi.json'))
PATHS = SPEC['paths']
SCHEMAS = SPEC.get('components', {}).get('schemas', {})
ORDER = ['get', 'post', 'put', 'patch', 'delete']

TAG_LABEL = {
    'EnterpriseStructure': 'Enterprise · Structure',
    'EnterpriseUser': 'Enterprise · Users',
    'EnterpriseRoles': 'Enterprise · Roles & Permissions',
    'EnterpriseInvite': 'Enterprise · Invitations',
    'EnterpriseActivation': 'Enterprise · Activation (public)',
    'EnterpriseProvisioning': 'Enterprise · Provisioning (Saveful admin)',
    'EnterpriseProfile': 'Enterprise · Organisation Profile',
    'EnterpriseReporting': 'Enterprise · Reporting',
    'EnterpriseAdminBilling': 'Enterprise · Contracts & Invoices (admin)',
    'EnterpriseInvoice': 'Enterprise · Invoices (customer)',
    'AdminEnterpriseSites': 'Enterprise · Sites (Saveful admin)',
    'AdminSites': 'Admin · Sites',
    'FoodListing': 'Food Listings',
    'FarmerConsumer': 'Farmer & Consumer',
    'RedisProxy': 'Driver Search',
    'RedisGeoSearch': 'Geo Search',
    'StripeWebhook': 'Stripe Webhook',
    'App': 'Health',
}

def label(tag):
    return TAG_LABEL.get(tag, tag)

def collect():
    groups = collections.defaultdict(list)
    for path, methods in PATHS.items():
        for method in ORDER:
            if method not in methods:
                continue
            op = methods[method]
            tag = (op.get('tags') or ['Other'])[0]
            groups[tag].append((path, method, op))
    for tag in groups:
        groups[tag].sort(key=lambda r: (r[0], ORDER.index(r[1])))
    return dict(sorted(groups.items(), key=lambda kv: label(kv[0])))

def ref_name(ref):
    return ref.rsplit('/', 1)[-1]

def type_of(s):
    """A short, readable type for a schema node."""
    if not isinstance(s, dict):
        return 'any'
    if '$ref' in s:
        return ref_name(s['$ref'])
    if s.get('enum'):
        return ' | '.join(str(e) for e in s['enum'])
    t = s.get('type', 'any')
    if t == 'array':
        return f"{type_of(s.get('items', {}))}[]"
    if s.get('format') == 'date-time':
        return 'string (date-time)'
    if s.get('format'):
        return f"{t} ({s['format']})"
    return t

def constraints(s):
    out = []
    for key, fmt in (
        ('minLength', 'min length {}'), ('maxLength', 'max length {}'),
        ('minimum', 'min {}'), ('maximum', 'max {}'),
        ('minItems', 'min {} item(s)'), ('maxItems', 'max {} items'),
    ):
        if key in s:
            out.append(fmt.format(s[key]))
    return ', '.join(out)

def body_schema(op):
    rb = op.get('requestBody')
    if not rb:
        return None
    content = rb.get('content', {})
    js = content.get('application/json') or content.get('multipart/form-data') or {}
    return js.get('schema')

def fields_of(schema, depth=0):
    """Flattens a body schema into (name, type, required, constraints) rows."""
    if not schema:
        return []
    if '$ref' in schema:
        schema = SCHEMAS.get(ref_name(schema['$ref']), {})
    if schema.get('type') == 'array':
        inner = schema.get('items', {})
        return fields_of(inner, depth)
    props = schema.get('properties') or {}
    required = set(schema.get('required') or [])
    rows = []
    for name, prop in props.items():
        rows.append((name, type_of(prop), name in required, constraints(prop)))
        if depth < 1 and '$ref' in prop:
            for sub in fields_of(prop, depth + 1):
                rows.append((f"{name}.{sub[0]}", sub[1], sub[2], sub[3]))
        if depth < 1 and prop.get('type') == 'array' and '$ref' in (prop.get('items') or {}):
            for sub in fields_of(prop['items'], depth + 1):
                rows.append((f"{name}[].{sub[0]}", sub[1], sub[2], sub[3]))
    return rows

def summarise(op, path, method):
    s = op.get('summary') or op.get('description') or ''
    s = s.strip().split('\n')[0]
    if s:
        return s
    oid = op.get('operationId', '')
    name = oid.split('_')[-1] if '_' in oid else oid
    name = re.sub(r'(?<!^)(?=[A-Z])', ' ', name).strip().capitalize()
    return name or f"{method.upper()} {path}"

GROUPS = collect()
TOTAL = sum(len(v) for v in GROUPS.values())
SECURED = sum(1 for v in GROUPS.values() for _, _, o in v if o.get('security'))

# ─── Markdown ────────────────────────────────────────────────────────────────
md = []
md.append('# Saveful for Business — API Reference\n')
md.append(f'{TOTAL} endpoints across {len(GROUPS)} areas. '
          f'{SECURED} require a bearer token; {TOTAL - SECURED} are public.\n')
md.append('All paths are prefixed `/api/v1`. Authenticate with '
          '`Authorization: Bearer <token>` from `POST /auth/login`.\n')
md.append('> Generated from the running application. Regenerate with `npm run docs:openapi`.\n')
md.append('\n## Contents\n')
for tag, rows in GROUPS.items():
    anchor = re.sub(r'[^a-z0-9]+', '-', label(tag).lower()).strip('-')
    md.append(f'- [{label(tag)}](#{anchor}) — {len(rows)} endpoints')
md.append('')

for tag, rows in GROUPS.items():
    md.append(f'\n## {label(tag)}\n')
    md.append('| Method | Path | Auth | Description |')
    md.append('|---|---|---|---|')
    for path, method, op in rows:
        auth = 'Bearer' if op.get('security') else 'Public'
        md.append(f'| `{method.upper()}` | `{path}` | {auth} | {summarise(op, path, method)} |')
    md.append('')
    for path, method, op in rows:
        md.append(f'\n### `{method.upper()}` {path}\n')
        md.append(f'{summarise(op, path, method)}\n')
        md.append(f'**Auth:** {"Bearer token required" if op.get("security") else "Public — no token"}\n')
        params = op.get('parameters') or []
        if params:
            md.append('**Parameters**\n')
            md.append('| Name | In | Required | Type |')
            md.append('|---|---|---|---|')
            for p in params:
                md.append(f"| `{p['name']}` | {p['in']} | {'yes' if p.get('required') else 'no'} "
                          f"| {type_of(p.get('schema', {}))} |")
            md.append('')
        rows_ = fields_of(body_schema(op))
        if rows_:
            md.append('**Request body**\n')
            md.append('| Field | Type | Required | Constraints |')
            md.append('|---|---|---|---|')
            for name, t, req, cons in rows_:
                md.append(f'| `{name}` | `{t}` | {"yes" if req else "no"} | {cons or "—"} |')
            md.append('')

os.makedirs('docs', exist_ok=True)
open('docs/API.md', 'w').write('\n'.join(md))
print(f'wrote docs/API.md ({len(md)} lines)')

# ─── HTML ────────────────────────────────────────────────────────────────────
def esc(x):
    return html.escape(str(x), quote=True)

def anchor_for(tag):
    return re.sub(r'[^a-z0-9]+', '-', label(tag).lower()).strip('-')

parts = []
parts.append('<div class="topbar"><div class="tb-inner">'
             '<span class="brand">Saveful <b>API</b></span>'
             '<input id="filter" type="search" placeholder="Filter endpoints — try &ldquo;groups&rdquo; or &ldquo;POST&rdquo;" '
             'autocomplete="off" spellcheck="false">'
             f'<span class="count" id="count">{TOTAL} endpoints</span>'
             '</div></div>')

parts.append('<div class="shell"><nav class="side"><p class="nav-h">Areas</p>')
for tag, rows in GROUPS.items():
    parts.append(f'<a href="#{anchor_for(tag)}" data-nav="{anchor_for(tag)}">'
                 f'<span>{esc(label(tag))}</span><em>{len(rows)}</em></a>')
parts.append('</nav><main class="main">')

parts.append(
    '<header class="hero">'
    '<p class="kick">Reference · generated from the running application</p>'
    '<h1>Saveful for Business API</h1>'
    f'<p class="lede">{TOTAL} endpoints across {len(GROUPS)} areas. '
    f'{SECURED} require a bearer token, {TOTAL - SECURED} are public. '
    'Every path below is prefixed <code>/api/v1</code>.</p>'
    '<div class="howto">'
    '<p><b>Authenticate</b> — call <code>POST /auth/login</code>, then send the token on every '
    'other request:</p>'
    '<pre><code>Authorization: Bearer &lt;token&gt;</code></pre>'
    '<p><b>Enterprise endpoints</b> also require the organisation to be on the Enterprise plan '
    'and check the caller&rsquo;s role and scope. A <code>403</code> carrying '
    '<code>MISSING_PERMISSION</code> means the role is wrong; <code>OUTSIDE_SCOPE</code> means '
    'the role is right but the target is outside what the caller can reach.</p>'
    '</div>'
    '</header>')

for tag, rows in GROUPS.items():
    parts.append(f'<section class="grp" id="{anchor_for(tag)}">')
    parts.append(f'<h2>{esc(label(tag))} <em>{len(rows)}</em></h2>')
    for path, method, op in rows:
        secured = bool(op.get('security'))
        desc = summarise(op, path, method)
        hay = esc(f"{method} {path} {desc}").lower()
        parts.append(f'<details class="ep" data-hay="{hay}">')
        parts.append(
            '<summary>'
            f'<span class="verb v-{method}">{method.upper()}</span>'
            f'<code class="path">{esc(path)}</code>'
            f'<span class="desc">{esc(desc)}</span>'
            + ('' if secured else '<span class="pub">public</span>')
            + '</summary>')
        parts.append('<div class="body">')
        parts.append(f'<p class="auth">{"Bearer token required" if secured else "No authentication — public endpoint"}</p>')

        params = op.get('parameters') or []
        if params:
            parts.append('<p class="lbl">Parameters</p><div class="tw"><table>'
                         '<thead><tr><th>Name</th><th>In</th><th>Required</th><th>Type</th></tr></thead><tbody>')
            for p in params:
                parts.append(
                    f"<tr><td><code>{esc(p['name'])}</code></td><td>{esc(p['in'])}</td>"
                    f"<td>{'yes' if p.get('required') else 'no'}</td>"
                    f"<td><code>{esc(type_of(p.get('schema', {})))}</code></td></tr>")
            parts.append('</tbody></table></div>')

        frows = fields_of(body_schema(op))
        if frows:
            parts.append('<p class="lbl">Request body</p><div class="tw"><table>'
                         '<thead><tr><th>Field</th><th>Type</th><th>Required</th><th>Constraints</th></tr></thead><tbody>')
            for name, t, req, cons in frows:
                parts.append(
                    f'<tr><td><code>{esc(name)}</code></td><td><code>{esc(t)}</code></td>'
                    f'<td>{"yes" if req else "no"}</td><td>{esc(cons) if cons else "—"}</td></tr>')
            parts.append('</tbody></table></div>')

        if not params and not frows:
            parts.append('<p class="none">No parameters or request body.</p>')
        parts.append('</div></details>')
    parts.append('</section>')

parts.append('</main></div>')

parts.append("""
<script>
(function () {
  var input = document.getElementById('filter');
  var count = document.getElementById('count');
  var eps = Array.prototype.slice.call(document.querySelectorAll('.ep'));
  var groups = Array.prototype.slice.call(document.querySelectorAll('.grp'));
  var total = eps.length;

  function apply() {
    var q = input.value.trim().toLowerCase();
    var shown = 0;
    eps.forEach(function (el) {
      var hit = !q || el.dataset.hay.indexOf(q) !== -1;
      el.hidden = !hit;
      if (hit) shown++;
    });
    groups.forEach(function (g) {
      g.hidden = !g.querySelector('.ep:not([hidden])');
    });
    count.textContent = q ? shown + ' of ' + total : total + ' endpoints';
  }
  input.addEventListener('input', apply);

  // Highlight the area currently in view.
  var links = {};
  document.querySelectorAll('[data-nav]').forEach(function (a) { links[a.dataset.nav] = a; });
  var obs = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      var a = links[e.target.id];
      if (a) a.classList.toggle('on', e.isIntersecting);
    });
  }, { rootMargin: '-70px 0px -75% 0px' });
  groups.forEach(function (g) { obs.observe(g); });
})();
</script>
""")

STYLE = open('scripts/api-docs.css').read()
open('docs/api-reference.html', 'w').write(
    '<title>Saveful API Reference</title>\n'
    '<link rel="preconnect" href="https://fonts.googleapis.com">\n'
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?'
    'family=JetBrains+Mono:wght@400;500;700&family=Public+Sans:wght@400;500;600;700&display=swap">\n'
    f'<style>\n{STYLE}\n</style>\n' + '\n'.join(parts))
print('wrote docs/api-reference.html')
