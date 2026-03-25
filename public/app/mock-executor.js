export async function executeMockQuery(queryDef) {
  var map = {
    'query:q_ontology_has_dcterms_license_with_url': true,
    'query:q_class_has_skos_definition': false,
    'query:q_ontology_has_dcterms_accessRights': true
  };

  if (!(queryDef['@id'] in map)) {
    throw new Error('No mock result configured for ' + queryDef['@id']);
  }

  return map[queryDef['@id']];
}