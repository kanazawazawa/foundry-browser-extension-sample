// Grants the Bridge Web App's System-Assigned Managed Identity the built-in "Foundry User" role
// on the shared Microsoft Foundry account so it can invoke agents and File Search without API keys.

@description('Name of the existing Microsoft Foundry (Cognitive Services) account')
param foundryAccountName string

@description('Principal ID of the Bridge Web App System-Assigned Managed Identity')
param principalId string

// Built-in role: Foundry User (53ca6127-db72-4b80-b1b0-d745d6d5456d)
var foundryUserRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '53ca6127-db72-4b80-b1b0-d745d6d5456d'
)

resource foundryAccount 'Microsoft.CognitiveServices/accounts@2024-10-01' existing = {
  name: foundryAccountName
}

resource foundryUserRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(foundryAccount.id, principalId, foundryUserRoleDefinitionId)
  scope: foundryAccount
  properties: {
    principalId: principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: foundryUserRoleDefinitionId
  }
}
