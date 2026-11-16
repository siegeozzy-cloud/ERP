import type { PushData } from '@erp/shared'
import { DarkTheme, DefaultTheme, NavigationContainer, useNavigationContainerRef } from '@react-navigation/native'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import * as Notifications from 'expo-notifications'
import { StatusBar } from 'expo-status-bar'
import { useEffect } from 'react'
import { Platform, Pressable, Text, useColorScheme, View } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { ApiError } from './lib/api'
import { SessionProvider, useSession } from './lib/session'
import { ForgotScreen, SignInScreen, SignUpScreen, type SignedOutStack } from './screens/auth'
import { ApprovalsScreen, ClockScreen, LeaveScreen, PayslipScreen, PayslipsScreen } from './screens/hr'
import { StockScreen } from './screens/stock'
import { TaskScreen, TasksScreen } from './screens/tasks'
import { AccountScreen, HomeScreen, JoinScreen, WorkspacesScreen, type SignedInStack } from './screens/workspace'
import { Brand, useColors } from './ui/components'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // a 4xx won't change by asking again; a dropped connection might
      retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
    },
  },
})

const Out = createNativeStackNavigator<SignedOutStack>()
const In = createNativeStackNavigator<SignedInStack>()

function AccountButton({ onPress }: { onPress: () => void }) {
  const c = useColors()
  return (
    // the web preview's header has no edge padding of its own; the phone's does
    <Pressable accessibilityRole="button" accessibilityLabel="Account" onPress={onPress} hitSlop={10} style={{ paddingRight: Platform.OS === 'web' ? 16 : 0 }}>
      <Text style={{ color: c.fg, fontSize: 16 }}>Account</Text>
    </Pressable>
  )
}

function Navigation() {
  const { state, chooseWorkspace } = useSession()
  const dark = useColorScheme() === 'dark'
  const c = useColors()
  const nav = useNavigationContainerRef<SignedInStack>()

  // tapping a notification opens the workspace it's about
  useEffect(() => {
    if (Platform.OS === 'web' || state.status !== 'signed-in') return
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as PushData
      if (!data.workspaceId) return
      const screen = data.screen === 'payslips' ? 'Payslips' : data.screen === 'leave' ? 'Leave' : data.screen === 'approvals' ? 'Approvals' : data.screen === 'tasks' ? 'Tasks' : 'Home'
      void chooseWorkspace(data.workspaceId).then(() => nav.isReady() && nav.navigate(screen))
    })
    return () => sub.remove()
  }, [state.status, chooseWorkspace, nav])

  if (state.status === 'loading') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.bg }}>
        <Brand />
      </View>
    )
  }

  const theme = dark ? { ...DarkTheme, colors: { ...DarkTheme.colors, background: c.bg, card: c.bg } } : { ...DefaultTheme, colors: { ...DefaultTheme.colors, background: c.bg, card: c.bg } }

  return (
    <NavigationContainer ref={nav} theme={theme}>
      {state.status === 'signed-out' ? (
        <Out.Navigator screenOptions={{ headerShadowVisible: false }}>
          <Out.Screen name="SignIn" component={SignInScreen} options={{ headerShown: false }} />
          <Out.Screen name="SignUp" component={SignUpScreen} options={{ title: '' }} />
          <Out.Screen name="Forgot" component={ForgotScreen} options={{ title: '' }} />
        </Out.Navigator>
      ) : (
        <In.Navigator
          // a remembered workspace opens straight away; otherwise, the list
          initialRouteName={state.workspaceId ? 'Home' : 'Workspaces'}
          screenOptions={({ navigation }) => ({
            headerShadowVisible: false,
            headerRight: () => <AccountButton onPress={() => navigation.navigate('Account')} />,
          })}
        >
          <In.Screen name="Workspaces" component={WorkspacesScreen} options={{ title: 'Workspaces' }} />
          <In.Screen name="Join" component={JoinScreen} options={{ title: 'Join' }} />
          <In.Screen name="Home" component={HomeScreen} options={{ title: '' }} />
          <In.Screen name="Stock" component={StockScreen} options={{ title: 'Stock' }} />
          <In.Screen name="Clock" component={ClockScreen} options={{ title: 'Time' }} />
          <In.Screen name="Leave" component={LeaveScreen} options={{ title: 'Leave' }} />
          <In.Screen name="Payslips" component={PayslipsScreen} options={{ title: 'Payslips' }} />
          <In.Screen name="Payslip" component={PayslipScreen} options={{ title: 'Payslip' }} />
          <In.Screen name="Approvals" component={ApprovalsScreen} options={{ title: 'Approvals' }} />
          <In.Screen name="Tasks" component={TasksScreen} options={{ title: 'My tasks' }} />
          <In.Screen name="Task" component={TaskScreen} options={{ title: 'Task' }} />
          <In.Screen name="Account" component={AccountScreen} options={{ title: 'Account', headerRight: undefined }} />
        </In.Navigator>
      )}
    </NavigationContainer>
  )
}

export function App() {
  const dark = useColorScheme() === 'dark'
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <SessionProvider>
          <StatusBar style={dark ? 'light' : 'dark'} />
          <Navigation />
        </SessionProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  )
}
