# Class recognition regression fixtures

For each rule, subclass-control must not derive `ex:x rdf:type ex:C`.
Both equivalence fixtures must derive that type. Parse in a fresh default-graph
store and execute the named rule. A superclass restriction gives a necessary
condition; only the explicit equivalence tested here gives a sufficient one.
These cases run against the shipped N3/Comunica bundles in Jest.
