from pathlib import Path

from reportlab.lib.utils import ImageReader
from reportlab.pdfgen.canvas import Canvas

root = Path(__file__).resolve().parent.parent
output = root / 'guide' / 'Oarlock-Brand-Guide.pdf'
titles = [
    'Take the helm.',
    'One mark. Three connections.',
    'A logo for every surface.',
    'Give the mark room.',
    'Quiet color. Clear contrast.',
    'Geometric. Human. Direct.',
    'Speak with purpose.',
    'Ready for the real world.',
]
pdf = Canvas(str(output), pagesize=(960, 600), pageCompression=1)
pdf.setTitle('Oarlock Brand Guide')
pdf.setAuthor('Oarlock / Quantum Ops Consulting, LLC')
pdf.setSubject('Version 1.0: logo system, color, typography, messaging and applications')
for index, title in enumerate(titles, 1):
    page = root / 'guide' / 'pages' / f'{index:02}.png'
    pdf.bookmarkPage(f'page-{index}')
    pdf.addOutlineEntry(title, f'page-{index}')
    pdf.drawImage(ImageReader(str(page)), 0, 0, width=960, height=600)
    pdf.showPage()
pdf.save()
print(output)
