console.clear();

figma.showUI(__html__, { width: 600, height: 600 });

// --- Types ---

interface JSONVariableValue {
  $type: string;
  $value?: any; // The raw value (e.g., RGBA object, number, string, boolean)
  $description?: string;
  targetCollection?: string; // For aliases (temporary, used during import)
  targetVariable?: string;   // For aliases (temporary, used during import)
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

function flattenVariables(obj: any, prefix: string = '', warnLegacy: { hasLegacy: boolean } = { hasLegacy: false }): Map<string, JSONVariableValue> {
  const result = new Map<string, JSONVariableValue>();
  
  for (const [key, value] of Object.entries(obj)) {
    // Skip internal keys (including DTCG $-prefixed metadata at group level)
    if (key.startsWith('_') || key.startsWith('$')) continue;

    const newKey = prefix ? `${prefix}/${key}` : key;
    
    if (value && typeof value === 'object') {
      // Check if it's a leaf node (Variable)
      // Support both DTCG format ($type, $value) and legacy format (type, value)
      const hasDTCGType = '$type' in value;
      const hasDTCGValue = '$value' in value;
      const hasLegacyType = 'type' in value;
      const hasLegacyValue = 'value' in value;
      
      const isVariable = (hasDTCGType && hasDTCGValue) || (hasLegacyType && hasLegacyValue);
      
      if (isVariable) {
        // Detect legacy format
        if (!hasDTCGType && !hasDTCGValue && (hasLegacyType || hasLegacyValue)) {
          warnLegacy.hasLegacy = true;
        }
        
        // Normalize to DTCG format
        const normalized: JSONVariableValue = {
          $type: (value as any).$type || (value as any).type,
          $value: (value as any).$value !== undefined ? (value as any).$value : (value as any).value,
          $description: (value as any).$description || (value as any).description,
        };
        result.set(newKey, normalized);
      } else {
        // It's a group, recurse
        const children = flattenVariables(value, newKey, warnLegacy);
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
    await handleExport(msg.format || 'simplified');
  } else if (msg.type === 'import-variables') {
    await handleImport(msg.data);
  } else if (msg.type === 'delete-all') {
    await handleDeleteAll();
  } else if (msg.type === 'cancel') {
    figma.closePlugin();
  }
};

async function handleDeleteAll() {
  try {
    log('INFO', 'Starting deletion of all variables...');
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    
    if (collections.length === 0) {
        log('INFO', 'No collections found to delete.');
        figma.ui.postMessage({ type: 'delete-success' });
        return;
    }

    for (const collection of collections) {
        log('INFO', `Deleting collection: ${collection.name}`);
        collection.remove();
    }

    log('INFO', 'All collections deleted successfully.');
    figma.ui.postMessage({ type: 'delete-success' });
  } catch (err) {
    log('ERROR', `Failed to delete variables: ${err}`);
    figma.ui.postMessage({ type: 'error', message: String(err) });
  }
}

// --- Export ---

// --- Export ---

type ExportFormat = 'simplified' | 'fullspec' | 'css' | 'tailwind';

// Helper function to convert Figma RGB to hex string
function rgbToHex(r: number, g: number, b: number): string {
  const rInt = Math.round(r * 255);
  const gInt = Math.round(g * 255);
  const bInt = Math.round(b * 255);
  return ((1 << 24) + (rInt << 16) + (gInt << 8) + bInt).toString(16).slice(1).toUpperCase();
}

// Convert value based on format
function convertValueForFormat(value: any, variable: Variable, format: ExportFormat): any {
  // Handle aliases (same for all formats)
  if (typeof value === 'object' && value !== null && 'type' in value && (value as VariableAlias).type === 'VARIABLE_ALIAS') {
    return null; // Signal that this needs alias handling  
  }

  // Format-specific conversion
  if (format === 'fullspec') {
    // W3C DTCG Spec format
    if (variable.resolvedType === 'COLOR' && typeof value === 'object' && 'r' in value) {
      return {
        colorSpace: 'srgb',
        components: [value.r, value.g, value.b]
      };
    } else if (variable.resolvedType === 'FLOAT') {
      return { value: value, unit: 'px' };
    }
    return value;
  } else if (format === 'simplified') {
    // Simplified format (current - hex colors, plain numbers)
    if (variable.resolvedType === 'COLOR' && typeof value === 'object' && 'r' in value) {
      return `#${rgbToHex(value.r, value.g, value.b)}`;
    }
    return value;
  } else {
    // CSS format - handled separately
    return value;
  }
}

async function handleExport(format: ExportFormat = 'simplified') {
  try {
    log('INFO', `Starting export in ${format} format...`);
    
    if (format === 'css') {
      await exportAsCSS();
      return;
    }
    
    if (format === 'tailwind') {
      await exportAsTailwind();
      return;
    }

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
          
          // Map Figma type to JSON type
          let jsonType = variable.resolvedType.toLowerCase();
          if (jsonType === 'float') {
            jsonType = format === 'fullspec' ? 'dimension' : 'number';
          }

          const exportValue: JSONVariableValue = {
            $type: jsonType,
            $description: variable.description,
          };

          // Check for Alias
          const convertedValue = convertValueForFormat(value, variable, format);
          
          if (convertedValue === null) {
            // It's an alias
            const aliasId = (value as VariableAlias).id;
            const targetVariable = await figma.variables.getVariableByIdAsync(aliasId);
            
            if (targetVariable) {
              const targetCollection = await figma.variables.getVariableCollectionByIdAsync(targetVariable.variableCollectionId);
              const collectionName = targetCollection?.name || 'Unknown';
              const varPath = targetVariable.name.replace(/\//g, '.');
              exportValue.$value = `{${collectionName}.${varPath}}`;
            } else {
              exportValue.$value = "BROKEN_ALIAS";
              log('WARN', `Broken alias found for variable "${variable.name}" in mode "${mode.name}"`);
            }
          } else {
            exportValue.$value = convertedValue;
          }

          // Reconstruct nested structure
          const parts = variable.name.split('/');
          let currentLevel: JSONGroup = result[collection.name][mode.name];
          
          for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            if (i === parts.length - 1) {
              // Leaf node
              currentLevel[part] = exportValue;
            } else {
              // Group node
              if (!currentLevel[part]) {
                currentLevel[part] = {};
              }
              currentLevel = currentLevel[part] as JSONGroup;
            }
          }
        }
      }
    }

    log('INFO', `Exported ${collections.length} collections.`);
    figma.ui.postMessage({ type: 'export-success', data: result, format });
  } catch (err) {
    log('ERROR', String(err));
    figma.ui.postMessage({ type: 'error', message: String(err) });
  }
}

async function exportAsCSS() {
  try {
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    const variables = await figma.variables.getLocalVariablesAsync();
    
    let css = '/* Design Tokens - CSS Variables */\n\n';

    for (const collection of collections) {
      const collectionVariables = variables.filter(v => v.variableCollectionId === collection.id);
      
      for (const mode of collection.modes) {
        css += `/* ${collection.name} - ${mode.name} */\n`;
        css += `:root {\n`;

        for (const variable of collectionVariables) {
          const value = variable.valuesByMode[mode.modeId];
          const varName = `--${collection.name}-${mode.name}-${variable.name}`.replace(/[/\s]/g, '-').toLowerCase();
          
          let cssValue: string;
          
          // Handle different types
          if (typeof value === 'object' && value !== null && 'type' in value && (value as VariableAlias).type === 'VARIABLE_ALIAS') {
            // Alias - reference another CSS variable
            const aliasId = (value as VariableAlias).id;
            const targetVariable = await figma.variables.getVariableByIdAsync(aliasId);
            if (targetVariable) {
              const targetCollection = await figma.variables.getVariableCollectionByIdAsync(targetVariable.variableCollectionId);
              const targetCollectionName = targetCollection?.name || 'unknown';
              const targetModeName = mode.name; // Assuming same mode
              const refVarName = `--${targetCollectionName}-${targetModeName}-${targetVariable.name}`.replace(/[/\s]/g, '-').toLowerCase();
              cssValue = `var(${refVarName})`;
            } else {
              cssValue = '/* BROKEN ALIAS */';
            }
          } else if (variable.resolvedType === 'COLOR' && typeof value === 'object' && value !== null && 'r' in value) {
            const rgb = value as RGB;  
            cssValue = `#${rgbToHex(rgb.r, rgb.g, rgb.b)}`;
          } else if (typeof value === 'number') {
            cssValue = String(value);
          } else if (typeof value === 'string') {
            cssValue = `"${value}"`;
          } else {
            cssValue = String(value);
          }
          
          css += `  ${varName}: ${cssValue};\n`;
        }
        
        css += `}\n\n`;
      }
    }

    log('INFO', `Exported ${collections.length} collections as CSS.`);
    figma.ui.postMessage({ type: 'export-success-css', data: css });
  } catch (err) {
    log('ERROR', String(err));
    figma.ui.postMessage({ type: 'error', message: String(err) });
  }
}

async function exportAsTailwind() {
  try {
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    const variables = await figma.variables.getLocalVariablesAsync();
    
    // Tailwind config structure
    const themeConfig: any = {
      colors: {},
      spacing: {},
      fontSize: {},
      fontFamily: {},
      fontWeight: {},
      lineHeight: {},
      borderRadius: {},
      boxShadow: {},
      opacity: {},
      zIndex: {},
    };

    for (const collection of collections) {
      const collectionVariables = variables.filter(v => v.variableCollectionId === collection.id);
      
      // Use first mode for Tailwind (Tailwind doesn't support modes natively)
      const mode = collection.modes[0];
      if (!mode) continue;

      for (const variable of collectionVariables) {
        const value = variable.valuesByMode[mode.modeId];
        
        // Convert variable name to Tailwind-friendly key
        // e.g. "color/primary/500" -> "primary-500"
        const nameParts = variable.name.split('/');
        const tailwindKey = nameParts.join('-').toLowerCase();
        
        // Determine which Tailwind theme key to use based on type
        if (variable.resolvedType === 'COLOR') {
          // Handle aliases
          if (typeof value === 'object' && value !== null && 'type' in value && (value as VariableAlias).type === 'VARIABLE_ALIAS') {
            const aliasId = (value as VariableAlias).id;
            const targetVariable = await figma.variables.getVariableByIdAsync(aliasId);
            if (targetVariable) {
              const refKey = targetVariable.name.split('/').join('-').toLowerCase();
              themeConfig.colors[tailwindKey] = `{colors.${refKey}}`;
            }
          } else if (typeof value === 'object' && 'r' in value) {
            const rgb = value as RGB;
            themeConfig.colors[tailwindKey] = `#${rgbToHex(rgb.r, rgb.g, rgb.b)}`;
          }
        } else if (variable.resolvedType === 'FLOAT') {
          // Could be spacing, fontSize, borderRadius, etc.
          // Try to infer from variable name
          const lowerName = variable.name.toLowerCase();
          
          if (lowerName.includes('spacing') || lowerName.includes('space') || lowerName.includes('gap') || lowerName.includes('margin') || lowerName.includes('padding')) {
            themeConfig.spacing[tailwindKey] = `${value}px`;
          } else if (lowerName.includes('font') && lowerName.includes('size')) {
            themeConfig.fontSize[tailwindKey] = `${value}px`;
          } else if (lowerName.includes('radius') || lowerName.includes('rounded')) {
            themeConfig.borderRadius[tailwindKey] = `${value}px`;
          } else {
            // Default to spacing
            themeConfig.spacing[tailwindKey] = `${value}px`;
          }
        } else if (variable.resolvedType === 'STRING') {
          const lowerName = variable.name.toLowerCase();
          if (lowerName.includes('font') && (lowerName.includes('family') || lowerName.includes('face'))) {
            themeConfig.fontFamily[tailwindKey] = typeof value === 'string' ? [value] : String(value);
          } else if (lowerName.includes('shadow')) {
            themeConfig.boxShadow[tailwindKey] = String(value);
          }
        }
      }
    }

    // Clean up empty sections
    Object.keys(themeConfig).forEach(key => {
      if (Object.keys(themeConfig[key]).length === 0) {
        delete themeConfig[key];
      }
    });

    // Generate JavaScript config file (avoid import keyword detection by Figma bundler)
    const typeComment = '/** @type {im' + 'port(\'tailwindcss\').Config} */';
    let tailwindConfig = typeComment + '\n';
    tailwindConfig += `module.exports = {\n`;
    tailwindConfig += `  theme: {\n`;
    tailwindConfig += `    extend: {\n`;
    
    // Add each theme section
    for (const [section, values] of Object.entries(themeConfig)) {
      tailwindConfig += `      ${section}: ${JSON.stringify(values, null, 8).replace(/^/gm, '      ').trim()},\n`;
    }
    
    tailwindConfig += `    },\n`;
    tailwindConfig += `  },\n`;
    tailwindConfig += `  plugins: [],\n`;
    tailwindConfig += `}\n`;

    log('INFO', `Exported ${collections.length} collections as Tailwind config.`);
    figma.ui.postMessage({ type: 'export-success-tailwind', data: tailwindConfig });
  } catch (err) {
    log('ERROR', String(err));
    figma.ui.postMessage({ type: 'error', message: String(err) });
  }
}

// --- Import ---

// Helper for chunking
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function handleImport(data: JSONRoot) {
  try {
    log('INFO', 'Starting import...');
    
    // Track if we encountered legacy format
    const legacyDetector = { hasLegacy: false };
    
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
        const variables = Array.from(flattenVariables(modes[firstModeName], '', legacyDetector));
        
        let processedCount = 0;
        for (const [varName, varData] of variables) {
            // Chunking: Yield every 20 variables
            if (processedCount % 20 === 0) {
                figma.ui.postMessage({ type: 'progress', message: `Creating variables... (${processedCount}/${variables.length})` });
                await delay(1);
            }
            processedCount++;

            const existingVars = await figma.variables.getLocalVariablesAsync();
            let variable = existingVars.find(v => v.name === varName && v.variableCollectionId === collection!.id);
            
            if (!variable) {
                let type: VariableResolvedDataType = 'STRING';
                // Check if it has a $type specified
                if (varData.$type) {
                    type = mapJsonTypeToFigmaType(varData.$type);
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

        const variables = Array.from(flattenVariables(varGroups, '', legacyDetector));
        
        let processedCount = 0;
        for (const [varName, varData] of variables) {
          // Chunking: Yield every 20 values
          if (processedCount % 20 === 0) {
             figma.ui.postMessage({ type: 'progress', message: `Setting values... (${processedCount}/${variables.length})` });
             await delay(1);
          }
          processedCount++;

          const localVariables = await figma.variables.getLocalVariablesAsync();
          const variable = localVariables.find(v => v.name === varName && v.variableCollectionId === collection.id);
          
          if (!variable) continue;

          try {
            let valueToSet = varData.$value;
            let isAlias = false;
            let targetCollectionName = '';
            let targetVariableName = '';

            // Check for explicit Alias object (legacy support)
            if (varData.targetCollection && varData.targetVariable) {
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
            } else {
              // Handle different value formats
              // Full Spec: Parse structured values
              if (typeof valueToSet === 'object' && valueToSet !== null) {
                // Color with colorSpace and components
                if ('colorSpace' in valueToSet && 'components' in valueToSet && Array.isArray(valueToSet.components)) {
                  // Convert from components [r, g, b] (0-1 range) to RGB object
                  const [r, g, b] = valueToSet.components;
                  valueToSet = { r, g, b, a: 1 };
                }
                // Dimension with value and unit
                else if ('value' in valueToSet && 'unit' in valueToSet) {
                  // Extract just the numeric value (Figma stores dimensions as numbers)
                  valueToSet = valueToSet.value;
                }
              }
              
              // Type conversions
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

    // Warn about legacy format if detected
    if (legacyDetector.hasLegacy) {
      log('WARN', 'Your JSON file uses legacy format (value/type). Please update to W3C DTCG format ($value/$type) for full compatibility.');
    }

    log('INFO', 'Import completed successfully.');
    figma.ui.postMessage({ type: 'import-success' });
  } catch (err) {
    log('ERROR', String(err));
    figma.ui.postMessage({ type: 'error', message: String(err) });
  }
}
