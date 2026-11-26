// ============================================================================
// Infrastructure as Code (Bicep) — Browser Extension x Foundry Agent Sample
// Deploys onto an existing Linux App Service Plan:
//   1. Company A Mock Expense Web App (Node.js 24 LTS)
//   2. Company B Mock Expense Web App (Node.js 24 LTS)
//   3. Foundry Bridge API - Passphrase mode (Python 3.13 + Managed Identity)
//   4. (Optional) Foundry Bridge API - Entra ID Easy Auth mode (when entraTenantId & entraClientId are set)
// ============================================================================

@description('Azure region for the Web Apps (must match the existing App Service Plan)')
param location string = resourceGroup().location

@description('Resource group of the existing Linux App Service Plan')
param appServicePlanResourceGroup string

@description('Name of the existing Linux App Service Plan')
param appServicePlanName string

@description('Resource group of the existing Microsoft Foundry account')
param foundryResourceGroup string

@description('Name of the existing Microsoft Foundry account')
param foundryAccountName string

@description('Microsoft Foundry project endpoint URL')
param foundryProjectEndpoint string

@description('Deployed model name used by the Foundry Agents')
param modelDeploymentName string = 'gpt-5.4-mini'

@description('Unique suffix used for default Web App names')
param nameSuffix string = uniqueString(resourceGroup().id)

@description('Web App name for Company A (Sakura Expense)')
param sakuraAppName string = 'app-sakura-${nameSuffix}'

@description('Web App name for Company B (Yamato J-Keihi)')
param yamatoAppName string = 'app-yamato-${nameSuffix}'

@description('Web App name for the Foundry Bridge API (Passphrase mode)')
param bridgeAppName string = 'app-foundry-bridge-${nameSuffix}'

@description('Web App name for the Foundry Bridge API (Entra ID Easy Auth mode)')
param bridgeEntraAppName string = 'app-foundry-bridge-entra-${nameSuffix}'

@secure()
@description('Passphrase required in X-Demo-Key header for the Passphrase Bridge API')
param demoAccessKey string = ''

@description('Optional Microsoft Entra Tenant ID. When set with entraClientId, provisions the Easy Auth Bridge Web App.')
param entraTenantId string = ''

@description('Optional Microsoft Entra Application (Client) ID for Easy Auth token validation.')
param entraClientId string = ''

@description('Optional additional client application IDs allowed to call the Easy Auth Bridge API.')
param additionalAllowedClientIds array = []

@description('Allowed CORS origins for the Bridge APIs (for example, ["chrome-extension://<extension-id>"]).')
param allowedOrigins array = []

var deployEntraBridge = !empty(entraTenantId) && !empty(entraClientId)
var allowedOriginsCsv = join(allowedOrigins, ',')

resource sharedPlan 'Microsoft.Web/serverfarms@2023-12-01' existing = {
  name: appServicePlanName
  scope: resourceGroup(appServicePlanResourceGroup)
}

resource sakuraWebApp 'Microsoft.Web/sites@2023-12-01' = {
  name: sakuraAppName
  location: location
  kind: 'app,linux'
  properties: {
    serverFarmId: sharedPlan.id
    httpsOnly: true
    publicNetworkAccess: 'Enabled'
    siteConfig: {
      linuxFxVersion: 'NODE|24-lts'
      appCommandLine: 'node server.mjs'
      alwaysOn: true
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      http20Enabled: true
      healthCheckPath: '/health'
      appSettings: [
        {
          name: 'SCM_DO_BUILD_DURING_DEPLOYMENT'
          value: 'false'
        }
      ]
    }
  }
}

resource yamatoWebApp 'Microsoft.Web/sites@2023-12-01' = {
  name: yamatoAppName
  location: location
  kind: 'app,linux'
  properties: {
    serverFarmId: sharedPlan.id
    httpsOnly: true
    publicNetworkAccess: 'Enabled'
    siteConfig: {
      linuxFxVersion: 'NODE|24-lts'
      appCommandLine: 'node server.mjs'
      alwaysOn: true
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      http20Enabled: true
      healthCheckPath: '/health'
      appSettings: [
        {
          name: 'SCM_DO_BUILD_DURING_DEPLOYMENT'
          value: 'false'
        }
      ]
    }
  }
}

resource bridgeWebApp 'Microsoft.Web/sites@2023-12-01' = {
  name: bridgeAppName
  location: location
  kind: 'app,linux'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: sharedPlan.id
    httpsOnly: true
    publicNetworkAccess: 'Enabled'
    siteConfig: {
      linuxFxVersion: 'PYTHON|3.13'
      appCommandLine: 'python -m uvicorn bridge_server:app --host 0.0.0.0 --port 8000'
      alwaysOn: true
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      http20Enabled: true
      healthCheckPath: '/api/health'
      appSettings: [
        {
          name: 'SCM_DO_BUILD_DURING_DEPLOYMENT'
          value: 'true'
        }
        {
          name: 'WEBSITES_PORT'
          value: '8000'
        }
        {
          name: 'WEBSITES_CONTAINER_START_TIME_LIMIT'
          value: '600'
        }
        {
          name: 'PROJECT_ENDPOINT'
          value: foundryProjectEndpoint
        }
        {
          name: 'MODEL_DEPLOYMENT_NAME'
          value: modelDeploymentName
        }
        {
          name: 'DEMO_ACCESS_KEY'
          value: demoAccessKey
        }
        {
          name: 'ALLOWED_ORIGINS'
          value: allowedOriginsCsv
        }
      ]
    }
  }
}

resource bridgeEntraWebApp 'Microsoft.Web/sites@2023-12-01' = if (deployEntraBridge) {
  name: bridgeEntraAppName
  location: location
  kind: 'app,linux'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: sharedPlan.id
    httpsOnly: true
    publicNetworkAccess: 'Enabled'
    siteConfig: {
      linuxFxVersion: 'PYTHON|3.13'
      appCommandLine: 'python -m uvicorn bridge_server:app --host 0.0.0.0 --port 8000'
      alwaysOn: true
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      http20Enabled: true
      healthCheckPath: '/api/health'
      cors: !empty(allowedOrigins)
        ? {
            allowedOrigins: allowedOrigins
            supportCredentials: false
          }
        : null
      appSettings: [
        {
          name: 'SCM_DO_BUILD_DURING_DEPLOYMENT'
          value: 'true'
        }
        {
          name: 'WEBSITES_PORT'
          value: '8000'
        }
        {
          name: 'WEBSITES_CONTAINER_START_TIME_LIMIT'
          value: '600'
        }
        {
          name: 'PROJECT_ENDPOINT'
          value: foundryProjectEndpoint
        }
        {
          name: 'MODEL_DEPLOYMENT_NAME'
          value: modelDeploymentName
        }
        {
          name: 'AZURE_TENANT_ID'
          value: entraTenantId
        }
        {
          name: 'ENTRA_CLIENT_ID'
          value: entraClientId
        }
        {
          name: 'ALLOWED_ORIGINS'
          value: allowedOriginsCsv
        }
      ]
    }
  }
}

resource bridgeEntraAuth 'Microsoft.Web/sites/config@2023-12-01' = if (deployEntraBridge) {
  parent: bridgeEntraWebApp
  name: 'authsettingsV2'
  properties: {
    platform: {
      enabled: true
    }
    globalValidation: {
      requireAuthentication: true
      unauthenticatedClientAction: 'Return401'
      excludedPaths: [
        '/api/health'
      ]
    }
    identityProviders: {
      azureActiveDirectory: {
        enabled: true
        registration: {
          clientId: entraClientId
          openIdIssuer: '${environment().authentication.loginEndpoint}${entraTenantId}/v2.0'
        }
        validation: {
          allowedAudiences: [
            entraClientId
            'api://${entraClientId}'
          ]
          defaultAuthorizationPolicy: {
            allowedApplications: union([entraClientId], additionalAllowedClientIds)
          }
        }
      }
    }
    login: {
      tokenStore: {
        enabled: true
      }
    }
    httpSettings: {
      requireHttps: true
    }
  }
}

module foundryRbac 'foundry-rbac.bicep' = {
  name: 'grant-bridge-foundry-user-rbac'
  scope: resourceGroup(foundryResourceGroup)
  params: {
    foundryAccountName: foundryAccountName
    principalId: bridgeWebApp.identity.principalId
  }
}

module foundryRbacEntra 'foundry-rbac.bicep' = if (deployEntraBridge) {
  name: 'grant-bridge-entra-foundry-user-rbac'
  scope: resourceGroup(foundryResourceGroup)
  params: {
    foundryAccountName: foundryAccountName
    principalId: bridgeEntraWebApp!.identity.principalId
  }
}

output sakuraUrl string = 'https://${sakuraWebApp.properties.defaultHostName}'
output yamatoUrl string = 'https://${yamatoWebApp.properties.defaultHostName}'
output bridgeUrl string = 'https://${bridgeWebApp.properties.defaultHostName}'
output bridgeEntraUrl string = deployEntraBridge ? 'https://${bridgeEntraWebApp!.properties.defaultHostName}' : ''
output bridgePrincipalId string = bridgeWebApp.identity.principalId
output bridgeEntraPrincipalId string = deployEntraBridge ? bridgeEntraWebApp!.identity.principalId : ''
