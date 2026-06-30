import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TextInput, TouchableOpacity, SafeAreaView, Alert, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface MathQuestion {
  num1: number;
  num2: number;
  operation: '+' | 'x';
  answer: number;
}

export default function ParentGate() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [question, setQuestion] = useState<MathQuestion | null>(null);
  const [userInput, setUserInput] = useState('');
  const [error, setError] = useState(false);

  useEffect(() => {
    generateQuestion();
  }, []);

  const generateQuestion = () => {
    const isMultiplication = Math.random() > 0.5;
    let num1, num2, answer;
    let operation: '+' | 'x' = isMultiplication ? 'x' : '+';

    if (isMultiplication) {
      num1 = Math.floor(3 + Math.random() * 7); // 3 to 9
      num2 = Math.floor(3 + Math.random() * 7); // 3 to 9
      answer = num1 * num2;
    } else {
      num1 = Math.floor(20 + Math.random() * 40); // 20 to 59
      num2 = Math.floor(20 + Math.random() * 40); // 20 to 59
      answer = num1 + num2;
    }

    setQuestion({ num1, num2, operation, answer });
    setUserInput('');
    setError(false);
  };

  const handleVerify = () => {
    if (!question) return;

    const parsedAnswer = parseInt(userInput.trim(), 10);
    if (parsedAnswer === question.answer) {
      // Correct! Route to Parent Dashboard
      router.replace('/parent/dashboard');
    } else {
      setError(true);
      setUserInput('');
      // Vibrate or show hint
      Alert.alert("Oops!", "That answer is not correct. Parents only! Ask your mom or dad for help.");
    }
  };

  if (!question) return null;

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: Platform.OS === 'android' ? (insets.top > 0 ? insets.top + 8 : 40) : 10 }]}>
        <TouchableOpacity style={styles.closeButton} onPress={() => router.back()}>
          <Ionicons name="close-circle" size={36} color="#8D6E63" />
        </TouchableOpacity>
      </View>

      <View style={styles.content}>
        <View style={styles.iconContainer}>
          <Text style={styles.lockIcon}>🔒</Text>
        </View>

        <Text style={styles.title}>Parents Only!</Text>
        <Text style={styles.subtitle}>
          Please solve this simple problem to verify you are a parent:
        </Text>

        {/* Question Area */}
        <View style={styles.equationContainer}>
          <Text style={styles.equationText}>
            {question.num1} {question.operation === 'x' ? '×' : '+'} {question.num2} = ?
          </Text>
        </View>

        {/* Answer Input */}
        <TextInput
          style={[styles.input, error && styles.inputError]}
          placeholder="Answer"
          placeholderTextColor="#A1887F"
          keyboardType="number-pad"
          value={userInput}
          onChangeText={setUserInput}
          onSubmitEditing={handleVerify}
          autoFocus={true}
        />

        {/* Verify Button */}
        <TouchableOpacity style={styles.verifyButton} onPress={handleVerify}>
          <Text style={styles.verifyButtonText}>Verify & Enter</Text>
        </TouchableOpacity>

        {/* Dynamic Retry Button */}
        <TouchableOpacity style={styles.retryButton} onPress={generateQuestion}>
          <Text style={styles.retryButtonText}>Give me another question</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFDF3',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: 20,
    paddingTop: Platform.OS === 'android' ? 40 : 10,
  },
  closeButton: {
    padding: 4,
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
    marginTop: -40,
  },
  iconContainer: {
    backgroundColor: '#FFEFC0',
    width: 90,
    height: 90,
    borderRadius: 45,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 24,
    borderWidth: 2,
    borderColor: '#FFD966',
  },
  lockIcon: {
    fontSize: 44,
  },
  title: {
    fontSize: 32,
    fontWeight: '900',
    color: '#4E342E',
    marginBottom: 12,
  },
  subtitle: {
    fontSize: 16,
    color: '#795548',
    textAlign: 'center',
    lineHeight: 24,
    marginBottom: 32,
    fontWeight: '600',
  },
  equationContainer: {
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    paddingVertical: 16,
    paddingHorizontal: 40,
    borderWidth: 2,
    borderColor: '#FFF5D1',
    marginBottom: 24,
    shadowColor: '#8D6E63',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 2,
  },
  equationText: {
    fontSize: 36,
    fontWeight: '900',
    color: '#4E342E',
    letterSpacing: 2,
  },
  input: {
    backgroundColor: '#FFFFFF',
    width: '100%',
    height: 64,
    borderRadius: 20,
    borderWidth: 2,
    borderColor: '#FFD966',
    textAlign: 'center',
    fontSize: 28,
    fontWeight: '800',
    color: '#4E342E',
    marginBottom: 24,
    shadowColor: '#8D6E63',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.05,
    shadowRadius: 6,
  },
  inputError: {
    borderColor: '#E57373',
    backgroundColor: '#FFEBEE',
  },
  verifyButton: {
    backgroundColor: '#FFC93C',
    borderRadius: 20,
    paddingVertical: 18,
    width: '100%',
    alignItems: 'center',
    shadowColor: '#FFC93C',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
    elevation: 3,
  },
  verifyButtonText: {
    fontSize: 18,
    fontWeight: '800',
    color: '#4E342E',
  },
  retryButton: {
    marginTop: 20,
    padding: 8,
  },
  retryButtonText: {
    fontSize: 14,
    color: '#8D6E63',
    fontWeight: '700',
    textDecorationLine: 'underline',
  },
});
