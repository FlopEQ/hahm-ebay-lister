"use client";

interface LabelPrintInput {
  sku: string;
  title: string;
  date?: Date;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function formatDate(date: Date): string {
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${mm}/${dd}/${date.getFullYear()}`;
}

function splitTitle(title: string): { headline: string; subtitle: string } {
  const clean = title.replace(/\s+/g, " ").trim();
  if (!clean) return { headline: "UNTITLED ITEM", subtitle: "" };
  const words = clean.split(" ");
  const headlineWords: string[] = [];
  const subtitleWords: string[] = [];
  for (const word of words) {
    const next = [...headlineWords, word].join(" ");
    if (headlineWords.length < 4 && next.length <= 28) {
      headlineWords.push(word);
    } else {
      subtitleWords.push(word);
    }
  }
  return {
    headline: (headlineWords.join(" ") || clean).toUpperCase(),
    subtitle: subtitleWords.join(" "),
  };
}

function labelMarkup({ sku, title, date = new Date() }: LabelPrintInput): string {
  const { headline, subtitle } = splitTitle(title);
  return `
  <main class="label">
    <section class="top">
      <h1 class="headline">${escapeHtml(headline)}</h1>
      <p class="subtitle">${escapeHtml(subtitle)}</p>
      <div class="sku"><span>SKU</span><span>${escapeHtml(sku)}</span></div>
      <div class="date"><span>DATE LISTED</span><span>${formatDate(date)}</span></div>
    </section>
    <section class="blank" aria-hidden="true"></section>
  </main>`;
}

export function printInventoryLabels(labels: LabelPrintInput[]): void {
  const printable = labels.filter((l) => l.sku.trim());
  if (printable.length === 0) return;
  const win = window.open("", "_blank", "width=480,height=720");
  if (!win) return;

  const title = printable.length === 1 ? printable[0].sku : `${printable.length} labels`;
  const body = `
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Inventory Label ${escapeHtml(title)}</title>
  <style>
    @page {
      size: 4in 6in;
      margin: 0;
    }
    * {
      box-sizing: border-box;
    }
    html,
    body {
      margin: 0;
      width: 4in;
      min-height: 6in;
      background: white;
      color: #000;
      font-family: Arial, Helvetica, sans-serif;
    }
    .label {
      width: 4in;
      height: 5.96in;
      padding: 0.28in 0.31in 0;
      overflow: hidden;
      page-break-after: always;
      break-after: page;
    }
    .label:last-of-type {
      page-break-after: avoid;
      break-after: avoid;
    }
    .top {
      height: 2.1in;
      border-bottom: 1.5pt solid #000;
      overflow: hidden;
    }
    .headline {
      font-size: 24pt;
      line-height: 1.05;
      font-weight: 800;
      letter-spacing: 0;
      margin: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .subtitle {
      font-size: 16pt;
      line-height: 1.15;
      margin: 0.15in 0 0;
      min-height: 0.28in;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .sku {
      display: flex;
      gap: 0.18in;
      align-items: baseline;
      margin-top: 0.18in;
      font-size: 26pt;
      line-height: 1;
      font-weight: 800;
      white-space: nowrap;
    }
    .date {
      display: flex;
      gap: 0.12in;
      align-items: baseline;
      margin-top: 0.25in;
      font-size: 14pt;
      line-height: 1;
      font-weight: 800;
      white-space: nowrap;
    }
    .blank {
      height: 3.75in;
    }
  </style>
</head>
<body>
  ${printable.map(labelMarkup).join("\n")}
  <script>
    window.addEventListener("load", () => {
      window.focus();
      window.print();
    });
  </script>
</body>
</html>`;

  try {
    win.document.open();
    win.document.write(body);
    win.document.close();
  } catch {
    win.location.href = `data:text/html;charset=utf-8,${encodeURIComponent(body)}`;
  }
}

export function printInventoryLabel(label: LabelPrintInput): void {
  printInventoryLabels([label]);
}
