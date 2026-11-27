# Builds the paper from the simulator's own engines and data.
#   make          run the engines, regenerate numbers / tables / plots, compile the PDF
#   make pdf      compile only (uses the results already in results/)
#   make clean    remove LaTeX intermediates
PDF = perjaya-weir-simulator-paper.pdf

all: results pdf

results:
	node scripts/run.mjs
	python3 scripts/build.py

pdf:
	mkdir -p build
	pdflatex -interaction=nonstopmode -halt-on-error -output-directory=build main.tex >/dev/null
	bibtex build/main >/dev/null
	pdflatex -interaction=nonstopmode -halt-on-error -output-directory=build main.tex >/dev/null
	pdflatex -interaction=nonstopmode -halt-on-error -output-directory=build main.tex | grep -E "Overfull|undefined|Warning: Citation|Output written" || true
	cp build/main.pdf $(PDF)

clean:
	rm -rf build

.PHONY: all results pdf clean
