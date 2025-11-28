import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Download, Monitor, CheckCircle, AlertCircle, Apple } from "lucide-react";

const APP_VERSION = "1.0.0";
const RELEASE_DATE = "November 2024";

export default function Downloads() {
  const systemRequirements = [
    "macOS 12 (Monterey) or later",
    "Apple Silicon (M1/M2/M3) or Intel processor",
    "4GB RAM minimum",
    "100MB free disk space",
    "Active internet connection",
  ];

  const features = [
    "Native macOS printer discovery",
    "Real-time print job delivery via WebSocket",
    "Secure Google Workspace authentication",
    "Station-based session management",
    "Automatic reconnection and heartbeat",
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
            <div className="flex items-center gap-3">
              <div className="p-3 rounded-lg bg-primary/10">
                <Apple className="h-8 w-8 text-primary" />
              </div>
              <div>
                <CardTitle className="text-xl" data-testid="text-app-name">
                  Jerky Ship Connect
                </CardTitle>
                <CardDescription>
                  Desktop printing client for macOS
                </CardDescription>
              </div>
            </div>
            <Badge variant="secondary" data-testid="badge-version">
              v{APP_VERSION}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
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

      <div className="grid md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Monitor className="h-5 w-5" />
              System Requirements
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2">
              {systemRequirements.map((req, index) => (
                <li 
                  key={index} 
                  className="flex items-start gap-2 text-sm"
                  data-testid={`text-requirement-${index}`}
                >
                  <CheckCircle className="h-4 w-4 text-green-500 mt-0.5 shrink-0" />
                  <span>{req}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle className="h-5 w-5" />
              Features
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2">
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
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Installation Instructions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <ol className="list-decimal list-inside space-y-3 text-sm">
            <li data-testid="text-install-step-1">
              <strong>Download</strong> the DMG file using the button above
            </li>
            <li data-testid="text-install-step-2">
              <strong>Open</strong> the downloaded .dmg file
            </li>
            <li data-testid="text-install-step-3">
              <strong>Drag</strong> Jerky Ship Connect to your Applications folder
            </li>
            <li data-testid="text-install-step-4">
              <strong>Launch</strong> the app from Applications or Spotlight
            </li>
            <li data-testid="text-install-step-5">
              <strong>Select your environment</strong> (Development or Production) from the dropdown
            </li>
            <li data-testid="text-install-step-6">
              <strong>Sign in</strong> with your @jerky.com Google account
            </li>
            <li data-testid="text-install-step-7">
              <strong>Select your station</strong> to start receiving print jobs
            </li>
          </ol>

          <div className="p-4 bg-muted rounded-lg mt-4">
            <p className="text-sm font-medium mb-2">First Launch Security Notice</p>
            <p className="text-sm text-muted-foreground">
              On first launch, macOS may show a security warning. Right-click the app and 
              select "Open" to bypass Gatekeeper. You only need to do this once.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
