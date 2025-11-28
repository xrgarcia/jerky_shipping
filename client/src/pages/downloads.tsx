import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Download, Monitor, CheckCircle, AlertCircle } from "lucide-react";
import { SiApple } from "react-icons/si";
import { FaWindows } from "react-icons/fa";

const APP_VERSION = "1.0.0";
const RELEASE_DATE = "November 2024";

export default function Downloads() {
  const macRequirements = [
    "macOS 12 (Monterey) or later",
    "Apple Silicon (M1/M2/M3) or Intel processor",
    "4GB RAM minimum",
    "100MB free disk space",
    "Active internet connection",
  ];

  const windowsRequirements = [
    "Windows 10 (64-bit) or later",
    "64-bit processor",
    "4GB RAM minimum",
    "100MB free disk space",
    "Active internet connection",
  ];

  const features = [
    "Native printer discovery",
    "Real-time print job delivery via WebSocket",
    "Secure Google Workspace authentication",
    "Station-based session management",
    "Automatic reconnection and heartbeat",
    "Environment switching (Production/Development)",
  ];

  return (
    <div className="container mx-auto py-8 px-4 max-w-4xl">
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2" data-testid="text-page-title">
          Desktop App Downloads
        </h1>
        <p className="text-muted-foreground text-lg">
          Download Jerky Ship Connect for native printing support
        </p>
      </div>

      <Card className="mb-6">
        <CardHeader>
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <CardTitle className="text-xl" data-testid="text-app-name">
                Jerky Ship Connect
              </CardTitle>
              <CardDescription>
                Desktop printing client for warehouse stations
              </CardDescription>
            </div>
            <Badge variant="secondary" data-testid="badge-version">
              v{APP_VERSION}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <Tabs defaultValue="windows" className="w-full">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="windows" className="flex items-center gap-2" data-testid="tab-windows">
                <FaWindows className="h-4 w-4" />
                Windows
              </TabsTrigger>
              <TabsTrigger value="macos" className="flex items-center gap-2" data-testid="tab-macos">
                <SiApple className="h-4 w-4" />
                macOS
              </TabsTrigger>
            </TabsList>
            
            <TabsContent value="windows" className="space-y-4 mt-4">
              <div className="flex flex-col sm:flex-row gap-4">
                <Button 
                  size="lg" 
                  className="flex-1"
                  data-testid="button-download-exe"
                  disabled
                >
                  <Download className="mr-2 h-5 w-5" />
                  Download Installer (.exe)
                </Button>
                <Button 
                  variant="outline" 
                  size="lg"
                  className="flex-1"
                  data-testid="button-download-portable"
                  disabled
                >
                  <Download className="mr-2 h-5 w-5" />
                  Portable Version
                </Button>
              </div>
              
              <div className="p-4 bg-muted rounded-lg">
                <p className="text-sm font-medium mb-2">System Requirements</p>
                <ul className="text-sm text-muted-foreground space-y-1">
                  {windowsRequirements.map((req, i) => (
                    <li key={i} className="flex items-center gap-2">
                      <CheckCircle className="h-3 w-3 text-green-500" />
                      {req}
                    </li>
                  ))}
                </ul>
              </div>
            </TabsContent>
            
            <TabsContent value="macos" className="space-y-4 mt-4">
              <div className="flex flex-col sm:flex-row gap-4">
                <Button 
                  size="lg" 
                  className="flex-1"
                  data-testid="button-download-dmg"
                  disabled
                >
                  <Download className="mr-2 h-5 w-5" />
                  Download for macOS (.dmg)
                </Button>
                <Button 
                  variant="outline" 
                  size="lg"
                  className="flex-1"
                  data-testid="button-download-zip"
                  disabled
                >
                  <Download className="mr-2 h-5 w-5" />
                  Download ZIP Archive
                </Button>
              </div>
              
              <div className="p-4 bg-muted rounded-lg">
                <p className="text-sm font-medium mb-2">System Requirements</p>
                <ul className="text-sm text-muted-foreground space-y-1">
                  {macRequirements.map((req, i) => (
                    <li key={i} className="flex items-center gap-2">
                      <CheckCircle className="h-3 w-3 text-green-500" />
                      {req}
                    </li>
                  ))}
                </ul>
              </div>
            </TabsContent>
          </Tabs>
          
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <AlertCircle className="h-4 w-4" />
            <span data-testid="text-build-status">
              Build coming soon. Contact IT for early access.
            </span>
          </div>

          <div className="pt-4 border-t">
            <p className="text-sm text-muted-foreground">
              Released: {RELEASE_DATE}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CheckCircle className="h-5 w-5" />
            Features
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="grid md:grid-cols-2 gap-2">
            {features.map((feature, index) => (
              <li 
                key={index} 
                className="flex items-start gap-2 text-sm"
                data-testid={`text-feature-${index}`}
              >
                <CheckCircle className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                <span>{feature}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Installation Instructions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Tabs defaultValue="windows-install">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="windows-install" className="flex items-center gap-2">
                <SiWindows className="h-4 w-4" />
                Windows
              </TabsTrigger>
              <TabsTrigger value="macos-install" className="flex items-center gap-2">
                <SiApple className="h-4 w-4" />
                macOS
              </TabsTrigger>
            </TabsList>
            
            <TabsContent value="windows-install" className="mt-4">
              <ol className="list-decimal list-inside space-y-3 text-sm">
                <li><strong>Download</strong> the installer (.exe) using the button above</li>
                <li><strong>Run</strong> the downloaded installer</li>
                <li><strong>Follow</strong> the installation wizard prompts</li>
                <li><strong>Launch</strong> Jerky Ship Connect from the Start Menu or Desktop</li>
                <li><strong>Select your environment</strong> (Development or Production) from the dropdown</li>
                <li><strong>Sign in</strong> with your @jerky.com Google account</li>
                <li><strong>Select your station</strong> to start receiving print jobs</li>
              </ol>

              <div className="p-4 bg-muted rounded-lg mt-4">
                <p className="text-sm font-medium mb-2">Windows SmartScreen Notice</p>
                <p className="text-sm text-muted-foreground">
                  On first launch, Windows SmartScreen may show a warning. Click "More info" then 
                  "Run anyway" to proceed. This is normal for new applications not yet widely distributed.
                </p>
              </div>
            </TabsContent>
            
            <TabsContent value="macos-install" className="mt-4">
              <ol className="list-decimal list-inside space-y-3 text-sm">
                <li><strong>Download</strong> the DMG file using the button above</li>
                <li><strong>Open</strong> the downloaded .dmg file</li>
                <li><strong>Drag</strong> Jerky Ship Connect to your Applications folder</li>
                <li><strong>Launch</strong> the app from Applications or Spotlight</li>
                <li><strong>Select your environment</strong> (Development or Production) from the dropdown</li>
                <li><strong>Sign in</strong> with your @jerky.com Google account</li>
                <li><strong>Select your station</strong> to start receiving print jobs</li>
              </ol>

              <div className="p-4 bg-muted rounded-lg mt-4">
                <p className="text-sm font-medium mb-2">First Launch Security Notice</p>
                <p className="text-sm text-muted-foreground">
                  On first launch, macOS may show a security warning. Right-click the app and 
                  select "Open" to bypass Gatekeeper. You only need to do this once.
                </p>
              </div>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
