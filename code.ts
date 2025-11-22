console.clear();

figma.showUI(__html__, { width: 400, height: 350 });

// --- Types ---

interface JSONVariableValue {
  type: VariableResolvedDataType | 'VARIABLE_ALIAS';
  value?: any; // The raw value (e.g., RGBA object, number, string, boolean)
  description?: string;
  targetCollection?: string; // For aliases
  targetVariable?: string;   // For aliases
}

// Recursive type for nested groups
interface JSONGroup {
  [key: string]: JSONVariableValue | JSONGroup;
}

interface JSONCollection {
  [modeName: string]: JSONGroup;
}

interface JSONRoot {
  [collectionName: string]: JSONCollection;
}

// --- Helper ---

function log(level: 'INFO' | 'WARN' | 'ERROR', message: string) {
  console.log(`[${level}] ${message}`);
  figma.ui.postMessage({ type: 'log', level, message });
}

function mapJsonTypeToFigmaType(jsonType: string): VariableResolvedDataType {
  const type = jsonType.toLowerCase();
  if (type === 'color') return 'COLOR';
  if (type === 'number') return 'FLOAT';
  if (type === 'boolean') return 'BOOLEAN';
  if (type === 'string') return 'STRING';
  // Fallback for unknown types (dimension, fontWeights, etc.)
  return 'STRING';
}

function flattenVariables(obj: any, prefix: string = ''): Map<string, JSONVariableValue> {
  const result = new Map<string, JSONVariableValue>();
  
  for (const [key, value] of Object.entries(obj)) {
    // Skip internal keys if any
    if (key.startsWith('_')) continue;

    const newKey = prefix ? `${prefix}/${key}` : key;
    
    if (value && typeof value === 'object') {
      // Check if it's a leaf node (Variable)
      // We check for 'type' and 'value' OR 'type' == 'VARIABLE_ALIAS'
      const hasType = 'type' in value;
      const hasValue = 'value' in value;
      const isAlias = hasType && (value as any).type === 'VARIABLE_ALIAS';
      
      if ((hasType && hasValue) || isAlias) {
        result.set(newKey, value as JSONVariableValue);
      } else {
        // It's a group, recurse
        const children = flattenVariables(value, newKey);
        for (const [childKey, childValue] of children) {
          result.set(childKey, childValue);
        }
      }
    }
  }
  
  return result;
}

// --- Main Logic ---

figma.ui.onmessage = async (msg) => {
  if (msg.type === 'export-variables') {
    await handleExport();
  } else if (msg.type === 'import-variables') {
    await handleImport(msg.data);
  } else if (msg.type === 'cancel') {
    figma.closePlugin();
  }
};

// --- Export ---

async function handleExport() {
  try {
    log('INFO', 'Starting export...');
    const result: JSONRoot = {};
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    const variables = await figma.variables.getLocalVariablesAsync();

    for (const collection of collections) {
      result[collection.name] = {};
      
      // Filter variables for this collection
      const collectionVariables = variables.filter(v => v.variableCollectionId === collection.id);

      for (const mode of collection.modes) {
        result[collection.name][mode.name] = {};

        for (const variable of collectionVariables) {
          const value = variable.valuesByMode[mode.modeId];
          const exportValue: JSONVariableValue = {
            type: variable.resolvedType,
            description: variable.description,
          };

          // Check for Alias
          if (typeof value === 'object' && value !== null && 'type' in value && (value as VariableAlias).type === 'VARIABLE_ALIAS') {
            exportValue.type = 'VARIABLE_ALIAS';
            const aliasId = (value as VariableAlias).id;
            const targetVariable = await figma.variables.getVariableByIdAsync(aliasId);
            if (targetVariable) {
              const targetCollection = await figma.variables.getVariableCollectionByIdAsync(targetVariable.variableCollectionId);
              exportValue.targetCollection = targetCollection?.name || 'Unknown';
              exportValue.targetVariable = targetVariable.name;
            } else {
              exportValue.value = "BROKEN_ALIAS";
              log('WARN', `Broken alias found for variable "${variable.name}" in mode "${mode.name}"`);
            }
          } else {
            // Primitive Value
            exportValue.value = value;
          }

          // Reconstruct nested structure
          const parts = variable.name.split('/');
          let currentLevel: JSONGroup = result[collection.name][mode.name];
          
          for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            if (i === parts.length - 1) {
              // Leaf
              currentLevel[part] = exportValue;
            } else {
              // Group
              if (!currentLevel[part]) {
                currentLevel[part] = {};
              }
              // We need to cast because TS doesn't know if it's a Group or VariableValue yet
              // But we know we just created it as {} or it was already a group
              currentLevel = currentLevel[part] as JSONGroup;
            }
          }
        }
      }
    }

    log('INFO', `Exported ${collections.length} collections.`);
    figma.ui.postMessage({ type: 'export-success', data: result });
  } catch (err) {
    log('ERROR', String(err));
    figma.ui.postMessage({ type: 'error', message: String(err) });
  }
}

// --- Import ---

async function handleImport(data: JSONRoot) {
  try {
    log('INFO', 'Starting import...');
    
    // Pass 1: Collections & Modes
    const collectionMap = new Map<string, VariableCollection>();
    const collectionModeMaps = new Map<string, Map<string, string>>(); // CollectionName -> { ModeName -> ModeId }

    for (const [collectionName, modes] of Object.entries(data)) {
      let collection = (await figma.variables.getLocalVariableCollectionsAsync()).find(c => c.name === collectionName);
      if (!collection) {
        collection = figma.variables.createVariableCollection(collectionName);
        log('INFO', `Creating collection: ${collectionName}`);
      }
      collectionMap.set(collectionName, collection);

      const modeMap = new Map<string, string>();
      const jsonModeNames = Object.keys(modes);
      
      // Fetch fresh modes
      const existingModes = collection.modes;

      for (let i = 0; i < jsonModeNames.length; i++) {
        const modeName = jsonModeNames[i];
        let modeId = existingModes.find(m => m.name === modeName)?.modeId;

        if (!modeId) {
            // Logic to rename "Mode 1" if it exists and we are processing the first mode
            // This prevents "Mode 1" from persisting as an unused mode
            const defaultMode = existingModes.find(m => m.name === "Mode 1");
            if (defaultMode && i === 0) {
                collection.renameMode(defaultMode.modeId, modeName);
                modeId = defaultMode.modeId;
                log('INFO', `Renamed default "Mode 1" to "${modeName}" in collection "${collectionName}"`);
            } else {
                modeId = collection.addMode(modeName);
                log('INFO', `Adding mode "${modeName}" to collection "${collectionName}"`);
            }
        }
        modeMap.set(modeName, modeId);
      }
      collectionModeMaps.set(collectionName, modeMap);
    }

    // Pass 2: Variables (Create variables if they don't exist)
    for (const [collectionName, modes] of Object.entries(data)) {
        const collection = collectionMap.get(collectionName);
        if (!collection) continue;

        // We assume all modes have the same variables, so we pick the first mode to discover variables
        const firstModeName = Object.keys(modes)[0];
        const variables = flattenVariables(modes[firstModeName]);

        for (const [varName, varData] of variables) {
            const existingVars = await figma.variables.getLocalVariablesAsync();
            let variable = existingVars.find(v => v.name === varName && v.variableCollectionId === collection!.id);
            
            if (!variable) {
                let type: VariableResolvedDataType = 'STRING';
                if (varData.type === 'VARIABLE_ALIAS') {
                     // Try to infer type from target... or default to STRING/COLOR if we can guess
                     // For now, we default to STRING if unknown, but we can try to look ahead?
                     // The mapJsonTypeToFigmaType helper handles this if we have a type.
                     // If it's an alias, varData might NOT have a 'type' field in some JSON schemas, 
                     // but in this user's file, aliases DO have "type": "color" etc.
                     if ('type' in varData) {
                         type = mapJsonTypeToFigmaType((varData as any).type);
                     }
                } else {
                    type = mapJsonTypeToFigmaType(varData.type);
                }
                
                try {
                    variable = figma.variables.createVariable(varName, collection, type);
                    log('INFO', `Creating variable: ${varName} (${type})`);
                } catch (e) {
                    log('ERROR', `Failed to create variable ${varName}: ${e}`);
                }
            }
        }
    }

    // Pass 3: Values
    for (const [collectionName, modes] of Object.entries(data)) {
      const collection = collectionMap.get(collectionName);
      if (!collection) continue;
      const modeMap = collectionModeMaps.get(collectionName);

      for (const [modeName, varGroups] of Object.entries(modes)) {
        const modeId = modeMap?.get(modeName);
        if (!modeId) continue;

        const flatVariables = flattenVariables(varGroups);
        
        for (const [varName, varData] of flatVariables) {
          const localVariables = await figma.variables.getLocalVariablesAsync();
          const variable = localVariables.find(v => v.name === varName && v.variableCollectionId === collection.id);
          
          if (!variable) continue;

          try {
            let valueToSet = varData.value;
            let isAlias = false;
            let targetCollectionName = '';
            let targetVariableName = '';

            // Check for explicit Alias object
            if (varData.type === 'VARIABLE_ALIAS' && varData.targetCollection && varData.targetVariable) {
              isAlias = true;
              targetCollectionName = varData.targetCollection;
              targetVariableName = varData.targetVariable;
            } 
            // Check for String Alias format: "{Collection.Path.To.Variable}"
            else if (typeof valueToSet === 'string' && valueToSet.startsWith('{') && valueToSet.endsWith('}')) {
               const content = valueToSet.substring(1, valueToSet.length - 1);
               const parts = content.split('.');
               if (parts.length >= 2) {
                   isAlias = true;
                   targetCollectionName = parts[0];
                   // Join the rest with '/' to match our variable naming convention
                   targetVariableName = parts.slice(1).join('/');
               }
            }

            if (isAlias) {
              // Resolve Alias
              const allCollections = await figma.variables.getLocalVariableCollectionsAsync();
              const allVars = await figma.variables.getLocalVariablesAsync();
              
              let targetVar: Variable | undefined;
              
              // 1. Try Exact Match
              const targetCol = allCollections.find(c => c.name === targetCollectionName);
              if (targetCol) {
                 targetVar = allVars.find(v => v.name === targetVariableName && v.variableCollectionId === targetCol.id);
              }

              // 2. Fuzzy Match (Fallback)
              if (!targetVar) {
                  // Search in ALL collections for the variable name
                  targetVar = allVars.find(v => v.name === targetVariableName);
                  if (targetVar) {
                      const foundCol = allCollections.find(c => c.id === targetVar.variableCollectionId);
                      log('WARN', `Fuzzy match found for alias "${targetVariableName}": Expected collection "${targetCollectionName}", found in "${foundCol?.name}"`);
                  }
              }

              if (targetVar) {
                variable.setValueForMode(modeId, figma.variables.createVariableAlias(targetVar));
              } else {
                log('WARN', `Alias target variable not found: "${targetVariableName}" (Collection: "${targetCollectionName}")`);
              }
            } else if (valueToSet !== undefined) {
              // Primitive Value Parsing
              
              // COLOR
              if (variable.resolvedType === 'COLOR' && typeof valueToSet === 'string' && valueToSet.startsWith('#')) {
                  valueToSet = figma.util.rgb(valueToSet);
              }
              // FLOAT
              else if (variable.resolvedType === 'FLOAT' && typeof valueToSet === 'string') {
                  const parsed = parseFloat(valueToSet);
                  if (!isNaN(parsed)) {
                      valueToSet = parsed;
                  }
              }
              // BOOLEAN
              else if (variable.resolvedType === 'BOOLEAN' && typeof valueToSet === 'string') {
                  if (valueToSet.toLowerCase() === 'true') valueToSet = true;
                  if (valueToSet.toLowerCase() === 'false') valueToSet = false;
              }
              
              variable.setValueForMode(modeId, valueToSet);
            }
          } catch (e) {
            log('ERROR', `Error setting value for "${varName}": ${e}`);
          }
        }
      }
    }

    log('INFO', 'Import completed successfully.');
    figma.ui.postMessage({ type: 'import-success' });
  } catch (err) {
    log('ERROR', String(err));
    figma.ui.postMessage({ type: 'error', message: String(err) });
  }
}
