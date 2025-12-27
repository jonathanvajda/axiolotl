import os
import sys
import json
import re
import logging
from rdflib import Graph, Namespace, RDF, OWL, RDFS, DCTERMS, DC, Literal

ONTOLOGY_FOLDER = 'ontology-files'

def read_ontology_folder(folder_path=ONTOLOGY_FOLDER):
    """
    Reads all ontology files from a folder, parses them, and returns a list of ontology metadata.
    Expected input: relative path to a folder containing ontology files (.ttl, .owl, .nt, .jsonld, .rdf).
    Output: List of ontology metadata dicts.
    """
    ontology_list = []
    logging.info(f"[read_ontology_folder] Reading folder: {folder_path}")
    for root, dirs, files in os.walk(folder_path):
        for file in files:
            if re.search(r'\.(ttl|owl|nt|jsonld|rdf)$', file, re.IGNORECASE):
                file_path = os.path.join(root, file)
                logging.info(f"[read_ontology_folder] Considering file: {file_path}")
                try:
                    with open(file_path, 'r', encoding='utf8') as f:
                        file_content = f.read()
                    parsed = parse_rdf(file_content, file, file_path)
                    ontology_meta = extract_ontology_metadata(parsed, file, file_path)
                    add_ontology_to_list(ontology_meta, ontology_list)
                except Exception as err:
                    logging.error(f"[read_ontology_folder] Error reading {file_path}: {err}")
    logging.info(f"[read_ontology_folder] Found {len(ontology_list)} ontologies.")
    return ontology_list

def add_ontology_to_list(ontology_meta, ontology_list):
    """
    Adds an ontology metadata dict to the list, enforcing uniqueness by ontologyIRI + versionIRI.
    """
    key = f"{ontology_meta.get('ontologyIRI', '')}|{ontology_meta.get('versionIRI', '')}"
    for o in ontology_list:
        if ((o.get('owl:ontologyIRI') or '', o.get('owl:versionIRI') or '') == key and any(key)):
            # same ontology+version (when at least one is present) -> skip
            return
        # Optional fallback: also dedupe by file name if no IRIs are present
        if not any(key) and (o.get('file:name') == ontology_meta.get('file:name')):
            return
    ontology_list.append(ontology_meta)

def extract_ontology_metadata(graph, file_name, file_path):
    """
    Extracts ontology metadata from a parsed RDF graph.
    Returns a dict with ontologyIRI, versionIRI, labels, and file name.
    """
    onto = next(graph.subjects(RDF.type, OWL.Ontology), None)
    ontologyIRI  = str(onto) if onto else None
    versionIRI   = str(next(graph.objects(onto, OWL.versionIRI), None)) if onto else None
    label_lit    = next(graph.objects(onto, RDFS.label), None) if onto else None
    dct_title    = next(graph.objects(onto, DCTERMS.title), None) if onto else None
    dc_title     = next(graph.objects(onto, DC.title), None) if onto else None
    version_info = next(graph.objects(onto, OWL.versionInfo), None) if onto else None

    return {
        'owl:ontologyIRI': ontologyIRI,
        'owl:versionIRI': versionIRI,
        'rdfs:label': str(label_lit) if label_lit is not None else None,
        'dcterms:title': str(dct_title) if dct_title is not None else None,
        'dc:title': str(dc_title) if dc_title is not None else None,
        'owl:versionInfo': str(version_info) if version_info is not None else None,
        'file:name': file_name,
    }

def parse_rdf(file_content, file_name, file_path):
    format_map = {
        '.ttl': 'turtle',
        '.owl': 'xml',
        '.nt': 'nt',
        '.jsonld': 'json-ld',
        '.rdf': 'xml'
    }
    ext = os.path.splitext(file_name)[1].lower()
    rdf_format = format_map.get(ext, 'turtle')
    g = Graph()
    try:
        g.parse(data=file_content, format=rdf_format, publicID=file_path)
        return g
    except Exception as err:
        logging.warning(f'[parse_rdf] Primary parse failed for {file_name} as {rdf_format}: {err}')
        # opportunistic fallback between xml/turtle
        try_alt = 'turtle' if rdf_format == 'xml' else 'xml'
        try:
            g.parse(data=file_content, format=try_alt, publicID=file_path)
            logging.info(f'[parse_rdf] Fallback parse succeeded for {file_name} as {try_alt}')
            return g
        except Exception as err2:
            logging.error(f'[parse_rdf] Fallback parse failed for {file_name}: {err2}')
            raise

def get_ontology_list(folder_path=ONTOLOGY_FOLDER):
    """
    Returns the list of ontologies by reading the ontology folder.
    """
    logging.info('[get_ontology_list] Getting ontology list...')
    ontology_list = read_ontology_folder(folder_path)
    logging.info(f'[get_ontology_list] Found {len(ontology_list)} ontologies.')
    return ontology_list

def main():
    import argparse
    parser = argparse.ArgumentParser(description="Extract ontology metadata to JSON.")
    parser.add_argument('--input', type=str, default=ONTOLOGY_FOLDER, help='Input folder containing ontology files')
    parser.add_argument('--output', type=str, default=os.path.join(ONTOLOGY_FOLDER, 'ontology-list.json'), help='Output JSON file path')
    args = parser.parse_args()

    ontology_list = get_ontology_list(args.input)
    with open(args.output, 'w', encoding='utf8') as f:
        json.dump(ontology_list, f, indent=2)

if __name__ == "__main__":
    main()